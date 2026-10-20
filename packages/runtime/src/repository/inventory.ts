// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { basename, posix } from "node:path";
import {
  REPOSITORY_MAX_BATCH_PROBES as MAX_BATCH_PROBES,
  isRepositoryLiteralProbeText,
  isRepositoryProbePath,
} from "./probe-selectors.js";

import {
  formatLimitObservation,
  formatLimitOverflow,
  limit,
  type LimitOverflowObservationV1,
  type ResolvedLimit,
  type ResolveLimitsOptions,
} from "../config/limits.js";
import {
  REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE,
  REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT,
  REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT,
  REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES_LIMIT,
  repositoryInventoryMaxEntries,
  repositoryInventoryMaxEntriesLimit,
} from "../config/repository-discovery-limits.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import {
  buildContentIndexV2,
  contentIndexAssetWarnings,
  contentIndexIncompleteWarning,
  quotedRepositoryText,
} from "../content-ir/indexer.js";
import { ContentIndexError } from "../content-ir/contracts.js";
import type { ContentIndexV2, ContentFormat } from "../content-ir/contracts.js";
import {
  RELEASE_DOCUMENTATION_CONTENT_CLASSES,
  releaseContentClassesForPath,
  type ReleaseDocumentationContentClass,
} from "../release-documentation-rubric.js";
import { decodeSearchTarget, type SearchTargetV1 } from "../search/bounded-search-contracts.js";
import {
  admitAuthorizedTrackedWrites,
  listTrackedRepositoryEntries,
  readTrackedRepositoryFile,
  readTrackedRepositoryFilePrefix,
  verifyTrackedRepositoryEntries,
} from "./workspace/tracked-read.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
  type TrackedRepositoryEntry,
} from "./workspace/contracts.js";
import type {
  RepositoryNavigationObservationRouteV1,
  RepositoryNavigationObservationSourceV1,
} from "./navigation-observation.js";
import { observeRepositoryNavigation } from "./navigation-observation.js";
import {
  documentationGeneratorForConfigurationPath,
  documentationGeneratorForPackageDependency,
} from "./documentation-source-support.js";
import type {
  RepositoryBatchProbeEvidenceV1,
  RepositoryBatchProbeQuestionV1,
  RepositoryBatchProbeRequestV1,
  RepositoryBatchProbeResultV1,
  RepositoryBatchReplayAuthorityV1,
  RepositoryBatchReplayTargetAuthorityV1,
  RepositoryDiscoveryInventoryV1,
  RepositoryInstructionScopeV1,
  RepositoryInventoryCommandV1,
  RepositoryInventoryCoverageKind,
  RepositoryInventoryCoverageV1,
  RepositoryInventoryDecisionFactV2,
  RepositoryInventoryDocumentProfileV2,
  RepositoryInventoryDocumentV1,
  RepositoryInventoryFailureCategory,
  RepositoryInventoryFailureV1,
  RepositoryInventoryFileV1,
  RepositoryInventoryNavigationV1,
  RepositoryInventorySignalV1,
} from "./inventory-contracts.js";

export type {
  RepositoryBatchProbeEvidenceV1,
  RepositoryBatchProbeQuestionV1,
  RepositoryBatchProbeRequestV1,
  RepositoryBatchProbeResultV1,
  RepositoryBatchReplayAuthorityV1,
  RepositoryBatchReplayTargetAuthorityV1,
  RepositoryDiscoveryInventoryV1,
  RepositoryInstructionScopeV1,
  RepositoryInventoryCommandV1,
  RepositoryInventoryCoverageKind,
  RepositoryInventoryCoverageV1,
  RepositoryInventoryDecisionFactV2,
  RepositoryInventoryDocumentProfileV2,
  RepositoryInventoryDocumentV1,
  RepositoryInventoryFailureCategory,
  RepositoryInventoryFailureV1,
  RepositoryInventoryFileV1,
  RepositoryInventoryNavigationV1,
  RepositoryInventorySignalV1,
} from "./inventory-contracts.js";
import { compareText, isPlainRecord } from "../shared/primitives.js";
import { isAgentInstructionFile } from "./agent-instruction-files.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_TOKEN = /^[A-Za-z0-9@][A-Za-z0-9._:@+/-]{0,127}$/u;
const SAFE_NAME = /^[A-Za-z0-9@._][A-Za-z0-9._:@+/-]{0,127}$/u;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/u;
const DOCUMENT = /(?:^|\/)(?:[^/]+\.(?:md|mdx|rst)|README|CONTRIBUTING)(?:\.(?:md|mdx|rst))?$/iu;
const CONTENT_IR_DOCUMENT = /\.(?:md|mdx)$/iu;
const CI_CONFIG =
  /^(?:\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml|\.github\/workflows\/[^/]+\.ya?ml)$/iu;
const PACKAGE_FILE = /(?:^|\/)package\.json$/u;
const CONFIG_FILE =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|uv\.lock|Cargo\.toml|Cargo\.lock|go\.mod|Makefile|tsconfig(?:\.[^/]+)?\.json)$/u;
const MAX_CONFIG_BYTES = 1024 * 1024;
const RELEASE_DECISIONS_PATH = ".docsfab-release-documentation-decisions.json";
const MAX_RESULTS_PER_PROBE = 128;
/**
 * Formats the text index excludes by extension, unread: images, PDF, web
 * fonts, ZIP archives, and video and audio. Video joined after the 2026-10-05
 * field run, where a repository's MP4 files, up to 50 MB, counted as text the
 * index left out (#1932).
 */
const KNOWN_BINARY =
  /\.(?:avif|gif|ico|jpe?g|pdf|png|webp|woff2?|zip|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|flac)$/iu;
/**
 * Bytes at the start of a file that decide whether it is binary: a NUL byte
 * among them marks binary content, as in Git's own heuristic (xdiff
 * `buffer_is_binary`). A classification window, not a size bound: it decides
 * which files the text index excludes, each recorded by path and counted
 * (#1932). A file that starts with a UTF-16 byte order mark is text in another
 * encoding rather than binary content, whatever NUL bytes follow.
 */
const BINARY_SNIFF_BYTES = 8_000;
/** Most paths an operator line names as examples of a counted group of files. */
const LINE_PATH_SAMPLE = 3;
const authenticInventories = new WeakSet<object>();
const privateInventoryStates = new WeakMap<object, PrivateInventoryState>();

interface PrivateInventoryState {
  searchableText: ReadonlyMap<string, string>;
  workspaceAuthority: {
    sourcePath: string;
    requestedRevision: string;
    revision: string;
  };
}

export class RepositoryInventoryError extends Error {
  public constructor(
    public readonly code:
      | "invalid-inventory"
      | "invalid-probe"
      | "target-mismatch"
      | "workspace-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryInventoryError";
  }
}

export async function buildRepositoryDiscoveryInventory(input: {
  workspace: RepositoryWorkspace;
  authorizedWritePaths?: readonly string[];
  limits?: ResolveLimitsOptions;
  /**
   * Receives one run-record warning for each linked asset the workspace
   * content index left out past a limit. The inventory itself is unchanged.
   */
  recordWarning?: (warning: string) => void;
}): Promise<RepositoryDiscoveryInventoryV1> {
  if (input.authorizedWritePaths && input.authorizedWritePaths.length > 0) {
    await admitAuthorizedTrackedWrites(input.workspace, input.authorizedWritePaths);
  }
  const maxEntries = repositoryInventoryMaxEntries(input.limits);
  const allEntries = await listTrackedRepositoryEntries(input.workspace);
  const entries = allEntries.slice(0, maxEntries);
  const regular = entries.filter(
    (
      entry,
    ): entry is TrackedRepositoryEntry & {
      path: string;
      byteLength: number;
    } => entry.kind === "regular" && entry.path !== undefined && entry.byteLength !== undefined,
  );
  const packageManager = packageManagerFor(regular.map((entry) => entry.path));
  const failures: RepositoryInventoryFailureV1[] = [];
  if (allEntries.length > maxEntries) {
    failures.push(
      failure("entry-limit-exceeded", undefined, input.workspace.revision, [
        "structure",
        "text",
        "navigation",
        "metadata",
      ]),
    );
  }

  const redactedCount = allEntries.filter((entry) => entry.kind === "excluded").length;
  if (redactedCount > 0) {
    failures.push(
      failure("entry-redacted", undefined, `${input.workspace.revision}:${redactedCount}`, [
        "structure",
        "text",
      ]),
    );
  }

  const candidateFiles = entries
    .filter(
      (entry): entry is TrackedRepositoryEntry & { path: string } =>
        entry.kind !== "excluded" && entry.path !== undefined,
    )
    .map((entry) => inventoryFile(entry))
    .sort(compareByPath);

  for (const entry of entries) {
    if ((entry.kind === "symlink" || entry.kind === "submodule") && entry.path) {
      failures.push(
        failure("unsafe-tracked-entry", entry.path, input.workspace.revision, [
          "structure",
          "text",
          "navigation",
          "metadata",
        ]),
      );
    }
  }

  let contentIndex: ContentIndexV2 | undefined;
  let contentIndexFailure: ContentIndexFailure | undefined;
  try {
    if (allEntries.length > maxEntries) throw new Error("entry-limit-exceeded");
    contentIndex = await buildContentIndexV2({ workspace: input.workspace });
  } catch (error) {
    contentIndexFailure = contentIndexFailureOf(error);
  }
  if (contentIndex && input.recordWarning) {
    for (const warning of contentIndexAssetWarnings(contentIndex)) input.recordWarning(warning);
  }
  if (contentIndexFailure?.warning && input.recordWarning) {
    input.recordWarning(contentIndexFailure.warning);
  }
  const navigationObservation = await observeRepositoryNavigation({
    workspace: input.workspace,
    entries,
    ...(contentIndex ? { contentIndex } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
  });
  if (contentIndexFailure) {
    failures.push(
      failure(
        "content-index-incomplete",
        contentIndexFailure.path,
        contentIndexFailure.detail,
        navigationObservation.status === "complete" ? [] : ["navigation"],
      ),
    );
  }
  if (navigationObservation.failures.length > 0) {
    failures.push(
      ...navigationObservation.failures.map((item) =>
        failure(
          "navigation-observation-incomplete",
          item.path,
          item.evidenceSha256,
          ["navigation"],
          item.overflow,
        ),
      ),
    );
  }

  const candidateDocuments = regular
    .filter((entry) => DOCUMENT.test(entry.path))
    .map((entry) => {
      const format = documentFormat(entry.path);
      if (!CONTENT_IR_DOCUMENT.test(entry.path)) {
        failures.push(
          failure("unsupported-document-format", entry.path, input.workspace.revision, [
            "navigation",
          ]),
        );
      }
      const pathParts = entry.path.split("/");
      const parent = pathParts.length === 1 ? null : pathParts.slice(0, -1).join("/");
      const body = {
        id: `document:${canonicalDigest(entry.path).slice(0, 32)}`,
        path: entry.path,
        format,
        depth: pathParts.length - 1,
        parent,
        candidateAudience: audienceFor(entry.path),
      };
      return { ...body, evidenceSha256: canonicalDigest(body) };
    })
    .sort(compareByPath);

  const signals: RepositoryInventorySignalV1[] = [];
  for (const entry of regular) {
    if (CI_CONFIG.test(entry.path)) {
      signals.push(signal("ci-validation", basename(entry.path), [entry.path]));
    }
    const siteGenerator = documentationGeneratorForConfigurationPath(entry.path);
    if (siteGenerator) {
      signals.push(signal("site-generator", siteGenerator, [entry.path]));
      signals.push(signal("configuration", basename(entry.path), [entry.path]));
    }
    if (CONFIG_FILE.test(entry.path)) {
      signals.push(signal("configuration", basename(entry.path), [entry.path]));
    }
  }

  const commands: RepositoryInventoryCommandV1[] = [];
  for (const entry of regular.filter((candidate) => PACKAGE_FILE.test(candidate.path))) {
    if (entry.byteLength > MAX_CONFIG_BYTES) {
      failures.push(failure("oversize-input", entry.path, input.workspace.revision, ["metadata"]));
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readTrackedRepositoryFile(input.workspace, entry.path, MAX_CONFIG_BYTES);
    } catch (error) {
      failures.push(readFailure(error, entry.path, input.workspace.revision, ["metadata"]));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      failures.push(
        failure("invalid-package-metadata", entry.path, input.workspace.revision, ["metadata"]),
      );
      continue;
    }
    if (!isPlainRecord(parsed)) {
      failures.push(
        failure("invalid-package-metadata", entry.path, input.workspace.revision, ["metadata"]),
      );
      continue;
    }
    const scripts = isPlainRecord(parsed.scripts) ? Object.keys(parsed.scripts) : [];
    for (const scriptName of scripts.sort()) {
      const purpose = commandPurpose(scriptName);
      if (!SAFE_TOKEN.test(scriptName)) continue;
      commands.push(
        command(purpose, packageManagerInvocation(packageManager, scriptName), entry.path),
      );
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const dependencies = isPlainRecord(parsed[field]) ? Object.keys(parsed[field]).sort() : [];
      for (const dependency of dependencies) {
        if (!SAFE_TOKEN.test(dependency)) continue;
        signals.push(signal("dependency", dependency, [entry.path]));
        const generator = documentationGeneratorForPackageDependency(dependency);
        if (generator) signals.push(signal("site-generator", generator, [entry.path]));
      }
    }
  }

  const candidateInstructionScopes = regular
    .filter((entry) => isAgentInstructionFile(entry.path))
    .map((entry) => instructionScope(entry.path))
    .sort(compareByPath);
  const searchableText = new Map<string, string>();
  let searchableBytes = 0;
  const textFileLimit = limit(REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT, input.limits);
  const textTotalLimit = limit(REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES_LIMIT, input.limits);
  // Files past the total are recorded after the loop, once the total the index
  // needed is known: that total is the value an operator raises the limit to.
  const pastTextTotal: string[] = [];
  let pastTextTotalBytes = 0;
  // Binary content the extension list missed, excluded like a known binary
  // format rather than counted as text a limit or an encoding left out.
  let binaryContentCount = 0;
  const excludeAsBinary = (path: string): void => {
    failures.push(failure("unsupported-text-format", path, input.workspace.revision, ["text"]));
  };
  for (const entry of regular.filter((candidate) => KNOWN_BINARY.test(candidate.path))) {
    excludeAsBinary(entry.path);
  }
  for (const entry of regular.filter((candidate) => !KNOWN_BINARY.test(candidate.path))) {
    const pastFile = entry.byteLength > textFileLimit.value;
    if (pastFile || searchableBytes + entry.byteLength > textTotalLimit.value) {
      // A file a limit leaves out is never read whole, but its first bytes say
      // whether it is text at all, so raising the limit is advised only for
      // files that the index could then hold.
      let prefix: Buffer;
      try {
        prefix = await readTrackedRepositoryFilePrefix(
          input.workspace,
          entry.path,
          BINARY_SNIFF_BYTES,
        );
      } catch (error) {
        failures.push(readFailure(error, entry.path, input.workspace.revision, ["text"]));
        continue;
      }
      if (startsWithUtf16ByteOrderMark(prefix)) {
        failures.push(
          failure("invalid-text-input", entry.path, input.workspace.revision, ["text"]),
        );
      } else if (looksBinary(prefix)) {
        binaryContentCount += 1;
        excludeAsBinary(entry.path);
      } else if (pastFile) {
        failures.push(
          failure("text-index-limit-exceeded", entry.path, input.workspace.revision, ["text"], {
            limitName: textFileLimit.name,
            observed: entry.byteLength,
          }),
        );
      } else {
        pastTextTotal.push(entry.path);
        pastTextTotalBytes += entry.byteLength;
      }
      continue;
    }
    try {
      const bytes = await readTrackedRepositoryFile(
        input.workspace,
        entry.path,
        textFileLimit.value,
      );
      if (startsWithUtf16ByteOrderMark(bytes)) {
        failures.push(
          failure("invalid-text-input", entry.path, input.workspace.revision, ["text"]),
        );
        continue;
      }
      if (looksBinary(bytes)) {
        binaryContentCount += 1;
        excludeAsBinary(entry.path);
        continue;
      }
      searchableText.set(entry.path, strictUtf8(bytes));
      searchableBytes += bytes.byteLength;
    } catch (error) {
      if (error instanceof TypeError) {
        failures.push(
          failure("invalid-text-input", entry.path, input.workspace.revision, ["text"]),
        );
      } else {
        failures.push(readFailure(error, entry.path, input.workspace.revision, ["text"]));
      }
    }
  }
  const textTotalNeeded = searchableBytes + pastTextTotalBytes;
  for (const path of pastTextTotal) {
    failures.push(
      failure("text-index-limit-exceeded", path, input.workspace.revision, ["text"], {
        limitName: textTotalLimit.name,
        observed: textTotalNeeded,
      }),
    );
  }
  let candidateDecisionFacts: RepositoryInventoryDecisionFactV2[] = [];
  const decisionEntry = regular.find((entry) => entry.path === RELEASE_DECISIONS_PATH);
  if (decisionEntry) {
    try {
      candidateDecisionFacts = decodeDecisionFacts(
        JSON.parse(
          (
            await readTrackedRepositoryFile(
              input.workspace,
              RELEASE_DECISIONS_PATH,
              MAX_CONFIG_BYTES,
            )
          ).toString("utf8"),
        ),
      );
    } catch {
      failures.push(
        failure("invalid-package-metadata", RELEASE_DECISIONS_PATH, input.workspace.revision, [
          "metadata",
        ]),
      );
    }
  }
  const finalStructure = await verifyTrackedRepositoryEntries(input.workspace);
  const changedPaths = new Set(
    finalStructure.flatMap((item) =>
      item.status === "changed" && item.path !== undefined ? [item.path] : [],
    ),
  );
  for (const observation of finalStructure.filter((item) => item.status === "changed")) {
    failures.push(
      failure("tracked-file-changed", observation.path, input.workspace.revision, [
        "structure",
        "text",
        "navigation",
        "metadata",
      ]),
    );
  }
  for (const path of changedPaths) searchableText.delete(path);
  const files = candidateFiles.filter((item) => !changedPaths.has(item.path));
  const documents = candidateDocuments.filter((item) => !changedPaths.has(item.path));
  const instructionScopes = candidateInstructionScopes.filter(
    (item) => !changedPaths.has(item.path),
  );
  const decisionFacts = changedPaths.has(RELEASE_DECISIONS_PATH) ? [] : candidateDecisionFacts;
  const normalizedSignals = dedupeSignals(
    signals.flatMap((item) => {
      const paths = item.paths.filter((path) => !changedPaths.has(path));
      return paths.length > 0 ? [signal(item.category, item.name, paths)] : [];
    }),
  );
  const normalizedCommands = dedupeCommands(
    commands.filter((item) => !changedPaths.has(item.packagePath)),
  );
  const normalizedFailures = dedupeFailures(failures);
  const nodePaths = new Map(contentIndex?.nodes.map((node) => [node.id, node.sourcePath]) ?? []);
  const admittedEdges = (contentIndex?.edges ?? []).filter((edge) => {
    const fromPath = nodePaths.get(edge.from);
    const toPath = nodePaths.get(edge.to);
    return !changedPaths.has(fromPath ?? "") && !changedPaths.has(toPath ?? "");
  });
  const navigationSources = navigationObservation.sources.filter(
    (source) => !changedPaths.has(source.path),
  );
  const navigationRoutes = navigationObservation.routes.filter(
    (route) => !changedPaths.has(route.sourcePath) && !changedPaths.has(route.path),
  );
  const graphPaths = navigationObservation.paths.filter((path) => !changedPaths.has(path));
  const navigationChanged = navigationObservation.paths.some((path) => changedPaths.has(path));
  const graphEdgeCount = navigationChanged ? 0 : navigationObservation.graphEdgeCount;
  const navigationEdgeCount = navigationChanged ? 0 : navigationObservation.navigationEdgeCount;
  const documentProfiles = documentProfilesFor({
    contentIndex,
    documents,
    searchableText,
    admittedEdges,
  });
  const coverage = {
    structure: coverageRecord(
      "structure",
      normalizedFailures,
      files.length,
      redactedCount,
      Math.max(0, allEntries.length - files.length - redactedCount),
    ),
    text: coverageRecord(
      "text",
      normalizedFailures,
      searchableText.size,
      regular.filter((entry) => KNOWN_BINARY.test(entry.path)).length + binaryContentCount,
      Math.max(
        0,
        regular.filter((entry) => !KNOWN_BINARY.test(entry.path)).length -
          binaryContentCount -
          searchableText.size +
          redactedCount,
      ),
    ),
    navigation: coverageRecord(
      "navigation",
      normalizedFailures,
      navigationEdgeCount,
      0,
      navigationObservation.status === "complete" ? 0 : 1,
    ),
    metadata: coverageRecord(
      "metadata",
      normalizedFailures,
      normalizedSignals.length + normalizedCommands.length + instructionScopes.length,
      0,
      normalizedFailures.filter((item) => item.affects.includes("metadata")).length,
    ),
  };
  const navigationBody = {
    id: `navigation:${canonicalDigest({ revision: input.workspace.revision }).slice(0, 32)}`,
    status: coverage.navigation.status,
    graphEdgeCount,
    navigationEdgeCount,
    paths: graphPaths,
    sources: navigationSources,
    routes: navigationRoutes,
  };
  const navigation = {
    ...navigationBody,
    evidenceSha256: canonicalDigest(navigationBody),
  };
  const structuralSha256 = canonicalDigest({
    revision: input.workspace.revision,
    tree: entries
      .filter((entry) => entry.kind !== "excluded")
      .map((entry) => ({
        kind: entry.kind,
        path: entry.path,
        byteLength: entry.byteLength,
      })),
    trackedEntryCount: allEntries.length,
    excludedCount: entries.filter((entry) => entry.kind === "excluded").length,
    contentIndexSha256: contentIndex?.indexDigest ?? null,
    navigationObservationSha256: navigationObservation.evidenceSha256,
    packageEvidence: [
      ...normalizedCommands,
      ...normalizedSignals.filter(
        (item) => item.category === "dependency" || item.category === "site-generator",
      ),
    ].map((item) => item.evidenceSha256),
  });
  const body = {
    schemaVersion: 2 as const,
    kind: "docsfab-repository-discovery-inventory" as const,
    repositoryRevision: input.workspace.revision,
    structuralSha256,
    status:
      Object.values(coverage).every((item) => item.status === "complete") &&
      contentIndex !== undefined
        ? ("complete" as const)
        : ("incomplete" as const),
    coverage,
    contentIndex: {
      status: contentIndex ? ("complete" as const) : ("incomplete" as const),
      indexSha256: contentIndex?.indexDigest ?? null,
      documentCount: contentIndex?.evidence.documentCount ?? 0,
      sectionCount: contentIndex?.evidence.sectionCount ?? 0,
      edgeCount: contentIndex?.evidence.edgeCount ?? 0,
    },
    files,
    navigation,
    documents,
    signals: normalizedSignals,
    commands: normalizedCommands,
    instructionScopes,
    documentProfiles,
    decisionFacts,
    failures: normalizedFailures,
  };
  const inventory = deepFreeze({ ...body, inventorySha256: canonicalDigest(body) });
  authenticInventories.add(inventory);
  privateInventoryStates.set(inventory, {
    searchableText,
    workspaceAuthority: {
      sourcePath: input.workspace.sourcePath,
      requestedRevision: input.workspace.requestedRevision,
      revision: input.workspace.revision,
    },
  });
  if (input.recordWarning) {
    for (const line of textIndexLimitLines(inventory, {
      [textFileLimit.name]: textFileLimit,
      [textTotalLimit.name]: textTotalLimit,
    })) {
      input.recordWarning(line);
    }
    const invalidText = invalidTextLine(inventory);
    if (invalidText) input.recordWarning(invalidText);
  }
  return inventory;
}

/**
 * Admit only the original host-produced inventory for this workspace. The
 * WeakMap registration is the trust boundary; a rehashed clone is not authority.
 */
export function validateRepositoryDiscoveryInventoryAuthority(
  value: unknown,
  expectedWorkspace: {
    sourcePath: string;
    requestedRevision: string;
    revision: string;
  },
): RepositoryDiscoveryInventoryV1 {
  if (!isPlainRecord(value) || !authenticInventories.has(value)) invalidInventory();
  const state = privateInventoryStates.get(value);
  if (!state || canonicalDigest(state.workspaceAuthority) !== canonicalDigest(expectedWorkspace)) {
    invalidInventory();
  }
  const inventory = decodeRepositoryDiscoveryInventory(value);
  if (inventory.repositoryRevision !== expectedWorkspace.revision) invalidInventory();
  return value as unknown as RepositoryDiscoveryInventoryV1;
}

function documentProfilesFor(input: {
  contentIndex: ContentIndexV2 | undefined;
  documents: readonly RepositoryInventoryDocumentV1[];
  searchableText: ReadonlyMap<string, string>;
  admittedEdges: readonly ContentIndexV2["edges"][number][];
}): RepositoryInventoryDocumentProfileV2[] {
  const nodes = input.contentIndex?.nodes ?? [];
  return input.documents
    .flatMap((document) => {
      const documentNode = nodes.find(
        (node): node is Extract<typeof node, { kind: "document" }> =>
          node.kind === "document" && node.sourcePath === document.path,
      );
      if (!documentNode || document.format === "rst") return [];
      const sections = nodes.filter(
        (node): node is Extract<typeof node, { kind: "section" }> =>
          node.kind === "section" && node.sourcePath === document.path,
      );
      const relatedEdges = input.admittedEdges.filter(
        (edge) =>
          edge.kind === "outbound-link" || edge.kind === "backlink" || edge.kind === "navigation",
      );
      const nodePaths = new Map(nodes.map((node) => [node.id, node.sourcePath]));
      const outgoing = relatedEdges.filter((edge) => nodePaths.get(edge.from) === document.path);
      const incoming = relatedEdges.filter((edge) => nodePaths.get(edge.to) === document.path);
      const contents = input.searchableText.get(document.path) ?? "";
      const body = {
        id: `document-profile:${canonicalDigest(document.path).slice(0, 32)}`,
        path: document.path,
        contentClasses: releaseContentClassesForPath(document.path).sort(),
        byteLength: documentNode.byteLength,
        sectionCount: sections.length,
        maximumSectionDepth: sections.reduce(
          (maximum, section) => Math.max(maximum, section.depth),
          0,
        ),
        substantiveSectionCount: sections.filter(
          (section) => section.endLine - section.startLine >= 3,
        ).length,
        procedureStepCount: contents
          .split(/\r?\n/u)
          .filter((line) => /^\s*\d+[.)]\s+\S/u.test(line)).length,
        codeBlockCount: documentNode.codeBlocks.length,
        incomingRelationshipCount: new Set(
          incoming.map((edge) => `${edge.kind}:${edge.from}:${edge.to}`),
        ).size,
        outgoingRelationshipCount: new Set(
          outgoing.map((edge) => `${edge.kind}:${edge.from}:${edge.to}`),
        ).size,
        navigationRelationshipCount: new Set(
          relatedEdges
            .filter(
              (edge) =>
                edge.kind === "navigation" &&
                (nodePaths.get(edge.from) === document.path ||
                  nodePaths.get(edge.to) === document.path),
            )
            .map((edge) => `${edge.from}:${edge.to}`),
        ).size,
      };
      return [{ ...body, evidenceSha256: canonicalDigest(body) }];
    })
    .sort(compareByPath);
}

function decodeDecisionFacts(value: unknown): RepositoryInventoryDecisionFactV2[] {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "decisions,schemaVersion" ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.decisions)
  ) {
    invalidInventory();
  }
  const topics = new Set<string>();
  const facts = value.decisions.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      Object.keys(candidate).sort().join(",") !== "status,topic" ||
      typeof candidate.topic !== "string" ||
      !SAFE_TOKEN.test(candidate.topic) ||
      (candidate.status !== "approved" && candidate.status !== "unknown") ||
      topics.has(candidate.topic)
    )
      invalidInventory();
    topics.add(candidate.topic);
    const body = {
      id: `decision:${canonicalDigest(candidate.topic).slice(0, 32)}`,
      topic: candidate.topic,
      status: candidate.status,
      path: RELEASE_DECISIONS_PATH,
    } as const;
    return { ...body, evidenceSha256: canonicalDigest(body) };
  });
  return facts.sort((left, right) => left.topic.localeCompare(right.topic));
}

/**
 * Recover-class operator lines for inventory truncation and recorded failures,
 * so `entry-limit-exceeded` overflow is never dropped silently. Files a text
 * index limit left out get one line per limit, with their count, rather than
 * one line per file; the inventory still records each by path.
 */
export function formatRepositoryInventoryLimitations(
  inventory: RepositoryDiscoveryInventoryV1,
  options?: ResolveLimitsOptions,
): readonly string[] {
  const textLines = textIndexLimitLines(inventory, {}, options);
  // The first failure a text index limit recorded stands for all of them, and
  // so does the first invalid-text failure.
  const firstTextFailure = inventory.failures.findIndex(
    (candidate) => candidate.category === "text-index-limit-exceeded" && candidate.overflow,
  );
  const firstInvalidText = inventory.failures.findIndex(
    (candidate) => candidate.category === "invalid-text-input",
  );
  return Object.freeze(
    inventory.failures.flatMap((failure, index) => {
      if (failure.category === "entry-limit-exceeded") {
        return [repositoryInventoryEntryLimitLine(inventory, options)];
      }
      if (failure.category === "text-index-limit-exceeded" && failure.overflow) {
        return index === firstTextFailure ? textLines : [];
      }
      if (failure.category === "invalid-text-input") {
        const line = index === firstInvalidText ? invalidTextLine(inventory) : undefined;
        return line ? [line] : [];
      }
      if (failure.category === "content-index-incomplete" && failure.path) {
        return [
          `repository-inventory-content-index-incomplete (${quotedRepositoryText(failure.path)})`,
        ];
      }
      if (failure.category === "navigation-observation-incomplete") {
        const prefix = failure.path
          ? `navigation-observation-incomplete (${failure.path})`
          : "navigation-observation-incomplete";
        if (!failure.overflow) return [prefix];
        return [
          `${prefix}; ${formatLimitOverflow(
            limit(failure.overflow.limitName, options),
            failure.overflow,
          )}`,
        ];
      }
      return [`repository-inventory-${failure.category}`];
    }),
  );
}

/**
 * The operator line for an inventory clipped at `repository.inventoryMaxEntries`,
 * naming the limit, the tracked entry count, and the remediation; `undefined`
 * when the inventory holds every tracked entry. Governed workflow search
 * records it on the run for every workflow, so the clip reaches LIMITATIONS
 * even when the run keeps no inventory (#1927).
 */
export function formatRepositoryInventoryEntryLimitation(
  inventory: RepositoryDiscoveryInventoryV1,
  options?: ResolveLimitsOptions,
): string | undefined {
  return inventory.failures.some((failure) => failure.category === "entry-limit-exceeded")
    ? repositoryInventoryEntryLimitLine(inventory, options)
    : undefined;
}

function repositoryInventoryEntryLimitLine(
  inventory: RepositoryDiscoveryInventoryV1,
  options?: ResolveLimitsOptions,
): string {
  const bound = repositoryInventoryMaxEntriesLimit(options);
  const observed = inventory.files.length + inventory.coverage.structure.omittedCount;
  return formatLimitObservation(bound, observed);
}

/**
 * One operator line for each text index limit that left files out of the
 * inventory's text index, naming the limit's code, the observed value, the
 * setting to raise, and how many files it left out (#1932). The observed value
 * is the largest left-out file for `repository.inventoryTextMaxFileBytes`, and
 * the total the index needed for `repository.inventoryTextMaxTotalBytes`:
 * raising the limit to it admits every file that limit left out.
 * `inForce` names the limits a build ran under; any other is resolved now.
 */
export function textIndexLimitLines(
  inventory: RepositoryDiscoveryInventoryV1,
  inForce: Readonly<Record<string, ResolvedLimit>> = {},
  options?: ResolveLimitsOptions,
): readonly string[] {
  const byLimit = new Map<string, { files: number; observed: number }>();
  for (const item of inventory.failures) {
    if (item.category !== "text-index-limit-exceeded" || !item.overflow) continue;
    const seen = byLimit.get(item.overflow.limitName) ?? { files: 0, observed: 0 };
    seen.files += 1;
    seen.observed = Math.max(seen.observed, item.overflow.observed ?? 0);
    byLimit.set(item.overflow.limitName, seen);
  }
  return Object.freeze(
    [
      REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT,
      REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES_LIMIT,
    ]
      .filter((name) => byLimit.has(name))
      .map((name) => {
        const { files, observed } = byLimit.get(name)!;
        const bound = inForce[name] ?? limit(name, options);
        const left = files === 1 ? "1 tracked file was" : `${files} tracked files were`;
        return `${formatLimitObservation(bound, observed)} ${left} left out of the repository text index; the inventory records each by path.`;
      }),
  );
}

/**
 * The operator line for tracked files the text index left out because they
 * are not UTF-8 text, naming how many and, in path order, up to three of them,
 * escaped; `undefined` when there are none (#1932). Binary content is excluded
 * before decoding, so these are text in another encoding. The run record keeps
 * lines of up to 1,024 characters, so examples that would pass that are dropped.
 */
export function invalidTextLine(inventory: RepositoryDiscoveryInventoryV1): string | undefined {
  const paths = inventory.failures
    .flatMap((item) => (item.category === "invalid-text-input" && item.path ? [item.path] : []))
    .sort(compareText);
  if (paths.length === 0) return undefined;
  const left =
    paths.length === 1
      ? "1 tracked file was left out of the repository text index because it is not UTF-8 text"
      : `${paths.length} tracked files were left out of the repository text index because they are not UTF-8 text`;
  const effect =
    "the inventory records each by path. Convert a file to UTF-8 to make it searchable.";
  const sample = paths.slice(0, LINE_PATH_SAMPLE).map(quotedRepositoryText);
  for (let count = sample.length; count > 0; count -= 1) {
    const line = `${REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE}: ${left}, for example ${sample.slice(0, count).join(", ")}; ${effect}`;
    if (line.length <= 1_024) return line;
  }
  return `${REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE}: ${left}; ${effect}`;
}

/** Binary content by Git's heuristic: a NUL byte among the first bytes. */
function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Text in UTF-16 starts with a byte order mark, `FF FE` or `FE FF`. Its ASCII
 * characters pair with NUL bytes, so it would otherwise pass for binary
 * content and go unnamed; the index cannot decode it, so it is counted, and
 * named by path, with text in another encoding (#1932).
 */
function startsWithUtf16ByteOrderMark(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  );
}

/** What the inventory records when its workspace content index cannot be built. */
interface ContentIndexFailure {
  /** Bound into the failure's evidence digest: the error type and, when coded, its code. */
  readonly detail: string;
  /** The page the refusal names, when it names a repository path the inventory admits. */
  readonly path?: string;
  /** The run-record warning naming the page and the reason, for a content index refusal. */
  readonly warning?: string;
}

function contentIndexFailureOf(error: unknown): ContentIndexFailure {
  if (error instanceof ContentIndexError) {
    const path =
      error.sourcePath !== undefined && isRepositoryProbePath(error.sourcePath)
        ? error.sourcePath
        : undefined;
    return {
      detail: `${error.name}:${error.code}`,
      ...(path ? { path } : {}),
      warning: contentIndexIncompleteWarning(error),
    };
  }
  return { detail: error instanceof Error ? error.name : "unknown-content-index-failure" };
}

/**
 * The closed navigation route grammar: a leading `/`, then segments of
 * unreserved characters separated by single slashes, with an optional trailing
 * slash. Each `/` ends a segment, so the match is linear in the route's length
 * (the earlier nested-quantifier form backtracked exponentially).
 */
const NAVIGATION_ROUTE = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/u;

export function isRepositoryNavigationRoute(value: unknown): value is string {
  return typeof value === "string" && NAVIGATION_ROUTE.test(value);
}

export function runRepositoryBatchProbes(input: {
  inventory: RepositoryDiscoveryInventoryV1;
  target: SearchTargetV1;
  probes: readonly RepositoryBatchProbeRequestV1[];
}): RepositoryBatchProbeEvidenceV1 {
  const authority = batchAuthority(input.inventory, input.target, input.probes);
  const evidence = createBatchEvidence(authority);
  return validateRepositoryBatchProbeEvidenceAuthority(evidence, {
    inventory: input.inventory,
    target: input.target,
    requests: input.probes,
  });
}

export function decodeRepositoryDiscoveryInventory(value: unknown): RepositoryDiscoveryInventoryV1 {
  assertInertPlainData(value);
  if (
    !isPlainRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.kind !== "docsfab-repository-discovery-inventory" ||
    typeof value.repositoryRevision !== "string" ||
    !REVISION.test(value.repositoryRevision) ||
    typeof value.structuralSha256 !== "string" ||
    !SHA256.test(value.structuralSha256) ||
    typeof value.inventorySha256 !== "string" ||
    !SHA256.test(value.inventorySha256) ||
    (value.status !== "complete" && value.status !== "incomplete") ||
    !isPlainRecord(value.coverage) ||
    !Array.isArray(value.files) ||
    !isPlainRecord(value.navigation) ||
    !Array.isArray(value.documents) ||
    !Array.isArray(value.signals) ||
    !Array.isArray(value.commands) ||
    !Array.isArray(value.instructionScopes) ||
    !Array.isArray(value.failures) ||
    !isPlainRecord(value.contentIndex)
  ) {
    throw new RepositoryInventoryError(
      "invalid-inventory",
      "Repository inventory shape is invalid.",
    );
  }
  const candidate = value as unknown as RepositoryDiscoveryInventoryV1;
  exactKeys(candidate, [
    "schemaVersion",
    "kind",
    "repositoryRevision",
    "structuralSha256",
    "inventorySha256",
    "status",
    "coverage",
    "contentIndex",
    "files",
    "navigation",
    "documents",
    "signals",
    "commands",
    "instructionScopes",
    ...(candidate.schemaVersion === 2 ? ["documentProfiles", "decisionFacts"] : []),
    "failures",
  ]);
  validateInventoryNested(candidate);
  const body = { ...structuredClone(candidate) } as RepositoryDiscoveryInventoryV1;
  delete (body as Partial<RepositoryDiscoveryInventoryV1>).inventorySha256;
  if (
    canonicalDigest(body) !== candidate.inventorySha256 ||
    (candidate.status === "complete") !==
      (Object.values(candidate.coverage).every((item) => item.status === "complete") &&
        candidate.contentIndex.status === "complete")
  ) {
    throw new RepositoryInventoryError(
      "invalid-inventory",
      "Repository inventory binding is invalid.",
    );
  }
  for (const path of inventoryPaths(candidate)) safePath(path);
  return deepFreeze(structuredClone(candidate));
}

/** Shape/digest decoder only. It is never sufficient search authority. */
export function decodeRepositoryBatchProbeEvidenceShape(
  value: unknown,
): RepositoryBatchProbeEvidenceV1 {
  assertInertPlainData(value);
  if (!isPlainRecord(value)) invalidProbeEvidence();
  exactKeys(value, [
    "schemaVersion",
    "kind",
    "targetId",
    "targetSha256",
    "repositoryRevision",
    "inventorySha256",
    "requestSetSha256",
    "results",
    "evidenceSha256",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-repository-batch-probe-evidence" ||
    typeof value.targetId !== "string" ||
    !SAFE_TOKEN.test(value.targetId) ||
    typeof value.targetSha256 !== "string" ||
    !SHA256.test(value.targetSha256) ||
    typeof value.repositoryRevision !== "string" ||
    !REVISION.test(value.repositoryRevision) ||
    typeof value.inventorySha256 !== "string" ||
    !SHA256.test(value.inventorySha256) ||
    typeof value.requestSetSha256 !== "string" ||
    !SHA256.test(value.requestSetSha256) ||
    !Array.isArray(value.results) ||
    value.results.length < 1 ||
    value.results.length > MAX_BATCH_PROBES ||
    typeof value.evidenceSha256 !== "string" ||
    !SHA256.test(value.evidenceSha256)
  ) {
    invalidProbeEvidence();
  }
  const resultIds = new Set<string>();
  const results = value.results as unknown as RepositoryBatchProbeResultV1[];
  for (const result of results) {
    if (!isPlainRecord(result)) invalidProbeEvidence();
    exactKeys(result, [
      "id",
      "requestSha256",
      "disposition",
      "failureCategory",
      "matchCount",
      "evidenceIds",
      "paths",
      "evidenceSha256",
    ]);
    safeIdentity(result.id);
    uniqueId(resultIds, result.id);
    if (
      !SHA256.test(result.requestSha256) ||
      !SHA256.test(result.evidenceSha256) ||
      !new Set(["found", "not-found-after-bounded-search", "incomplete", "unsupported"]).has(
        result.disposition,
      ) ||
      !new Set([
        null,
        "structure-incomplete",
        "text-index-incomplete",
        "navigation-index-incomplete",
        "metadata-index-incomplete",
        "unsupported-question",
      ]).has(result.failureCategory) ||
      !Number.isSafeInteger(result.matchCount) ||
      result.matchCount < 0 ||
      !Array.isArray(result.evidenceIds) ||
      !Array.isArray(result.paths) ||
      result.evidenceIds.length > MAX_RESULTS_PER_PROBE ||
      result.paths.length > MAX_RESULTS_PER_PROBE ||
      new Set(result.evidenceIds).size !== result.evidenceIds.length ||
      new Set(result.paths).size !== result.paths.length ||
      result.evidenceIds.some((id) => !SAFE_TOKEN.test(id)) ||
      result.paths.some((path) => {
        try {
          safePath(path);
          return false;
        } catch {
          return true;
        }
      }) ||
      result.matchCount < result.evidenceIds.length ||
      (result.disposition === "found") !== result.matchCount > 0 ||
      (result.disposition === "not-found-after-bounded-search" &&
        result.failureCategory !== null) ||
      (result.disposition === "incomplete" &&
        !String(result.failureCategory).endsWith("incomplete")) ||
      (result.disposition === "unsupported" && result.failureCategory !== "unsupported-question") ||
      (result.disposition === "found" && result.failureCategory !== null)
    ) {
      throw new RepositoryInventoryError(
        "invalid-inventory",
        `Repository batch probe result ${result.id} is invalid.`,
      );
    }
    const body = {
      id: result.id,
      requestSha256: result.requestSha256,
      disposition: result.disposition,
      failureCategory: result.failureCategory,
      matchCount: result.matchCount,
      evidenceIds: result.evidenceIds,
      paths: result.paths,
    };
    if (
      canonicalDigest({
        inventorySha256: value.inventorySha256,
        targetSha256: value.targetSha256,
        requestSha256: result.requestSha256,
        result: body,
      }) !== result.evidenceSha256
    )
      invalidProbeEvidence();
  }
  const body = {
    schemaVersion: 1,
    kind: "docsfab-repository-batch-probe-evidence",
    targetId: value.targetId,
    targetSha256: value.targetSha256,
    repositoryRevision: value.repositoryRevision,
    inventorySha256: value.inventorySha256,
    requestSetSha256: value.requestSetSha256,
    results,
  };
  if (canonicalDigest(body) !== value.evidenceSha256) invalidProbeEvidence();
  return deepFreeze(structuredClone(value)) as unknown as RepositoryBatchProbeEvidenceV1;
}

/** Replays the expected requests against the host inventory and requires exact result bytes. */
export function validateRepositoryBatchProbeEvidenceAuthority(
  value: unknown,
  expected: {
    inventory: RepositoryDiscoveryInventoryV1;
    target: SearchTargetV1;
    requests: readonly RepositoryBatchProbeRequestV1[];
  },
): RepositoryBatchProbeEvidenceV1 {
  const authority = batchAuthority(expected.inventory, expected.target, expected.requests);
  const decoded = decodeRepositoryBatchProbeEvidenceShape(value);
  const authentic = createBatchEvidence(authority);
  if (canonicalDigest(decoded) !== canonicalDigest(authentic)) invalidProbeEvidence();
  validateResultMappings(decoded, authority.inventory);
  return decoded;
}

export function createRepositoryBatchReplayAuthority(input: {
  repositoryIdentitySha256: string;
  inventory: RepositoryDiscoveryInventoryV1;
  targets: readonly {
    target: SearchTargetV1;
    requests: readonly RepositoryBatchProbeRequestV1[];
    evidence: RepositoryBatchProbeEvidenceV1;
  }[];
}): RepositoryBatchReplayAuthorityV1 {
  if (
    !SHA256.test(input.repositoryIdentitySha256) ||
    !authenticInventories.has(input.inventory) ||
    input.inventory.schemaVersion !== 2 ||
    input.targets.length === 0
  )
    invalidInventory();
  const targets = input.targets.map((item) => ({
    targetId: decodeSearchTarget(item.target).id,
    requests: [...normalizeProbeRequests(item.requests)],
    evidence: validateRepositoryBatchProbeEvidenceAuthority(item.evidence, {
      inventory: input.inventory,
      target: item.target,
      requests: item.requests,
    }),
  }));
  if (
    new Set(targets.map((item) => item.targetId)).size !== targets.length ||
    input.targets.some(
      (item) => item.target.repository.identitySha256 !== input.repositoryIdentitySha256,
    )
  )
    invalidInventory();
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-repository-batch-replay-authority" as const,
    repositoryIdentitySha256: input.repositoryIdentitySha256,
    repositoryRevision: input.inventory.repositoryRevision,
    inventory: decodeRepositoryDiscoveryInventory(input.inventory),
    targets,
  };
  return deepFreeze({ ...body, authoritySha256: canonicalDigest(body) });
}

export function validateRepositoryBatchReplayAuthority(
  value: unknown,
  expected: {
    repositoryIdentitySha256: string;
    repositoryRevision: string;
    repositoryWorkspace: {
      sourcePath: string;
      requestedRevision: string;
      revision: string;
    };
    trustedInventory: RepositoryDiscoveryInventoryV1;
    targets: readonly SearchTargetV1[];
    requestsForTarget(target: SearchTargetV1): readonly RepositoryBatchProbeRequestV1[];
  },
): RepositoryBatchReplayAuthorityV1 {
  const trustedInventory = validateRepositoryDiscoveryInventoryAuthority(
    expected.trustedInventory,
    expected.repositoryWorkspace,
  );
  if (expected.repositoryRevision !== expected.repositoryWorkspace.revision) invalidInventory();
  assertInertPlainData(value);
  if (!isPlainRecord(value)) invalidInventory();
  exactKeys(value, [
    "schemaVersion",
    "kind",
    "repositoryIdentitySha256",
    "repositoryRevision",
    "inventory",
    "targets",
    "authoritySha256",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-repository-batch-replay-authority" ||
    value.repositoryIdentitySha256 !== expected.repositoryIdentitySha256 ||
    value.repositoryRevision !== expected.repositoryRevision ||
    !SHA256.test(value.repositoryIdentitySha256) ||
    !REVISION.test(value.repositoryRevision) ||
    typeof value.authoritySha256 !== "string" ||
    !SHA256.test(value.authoritySha256) ||
    !Array.isArray(value.targets) ||
    value.targets.length !== expected.targets.length
  )
    invalidInventory();
  const inventory = decodeRepositoryDiscoveryInventory(value.inventory);
  if (
    inventory.schemaVersion !== 2 ||
    inventory.repositoryRevision !== expected.repositoryRevision
  ) {
    invalidInventory();
  }
  if (canonicalDigest(inventory) !== canonicalDigest(trustedInventory)) invalidInventory();
  const targets = value.targets.map((raw, index) => {
    if (!isPlainRecord(raw)) invalidInventory();
    exactKeys(raw, ["targetId", "requests", "evidence"]);
    const target = expected.targets[index];
    if (
      !target ||
      raw.targetId !== target.id ||
      target.repository.identitySha256 !== expected.repositoryIdentitySha256 ||
      target.repository.revision !== expected.repositoryRevision ||
      !Array.isArray(raw.requests)
    )
      invalidInventory();
    const requests = normalizeProbeRequests(raw.requests as RepositoryBatchProbeRequestV1[]);
    const expectedRequests = normalizeProbeRequests(expected.requestsForTarget(target));
    if (
      canonicalDigest(requests) !== canonicalDigest(expectedRequests) ||
      requests.some(
        (request) =>
          request.question.kind === "literal-text" || request.question.kind === "unsupported",
      )
    )
      invalidInventory();
    const evidence = decodeRepositoryBatchProbeEvidenceShape(raw.evidence);
    const replayed = createReplayBatchEvidence(inventory, target, requests);
    if (canonicalDigest(evidence) !== canonicalDigest(replayed)) invalidInventory();
    validateResultMappings(evidence, inventory);
    return { targetId: target.id, requests: [...requests], evidence };
  });
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-repository-batch-replay-authority" as const,
    repositoryIdentitySha256: expected.repositoryIdentitySha256,
    repositoryRevision: expected.repositoryRevision,
    inventory,
    targets,
  };
  if (canonicalDigest(body) !== value.authoritySha256) invalidInventory();
  return deepFreeze({ ...body, authoritySha256: value.authoritySha256 });
}

function createReplayBatchEvidence(
  inventory: RepositoryDiscoveryInventoryV1,
  target: SearchTargetV1,
  requests: readonly RepositoryBatchProbeRequestV1[],
): RepositoryBatchProbeEvidenceV1 {
  const results = requests.map((request) =>
    answerProbe(inventory, target, request, { searchableText: new Map() }),
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-repository-batch-probe-evidence" as const,
    targetId: target.id,
    targetSha256: target.targetSha256,
    repositoryRevision: inventory.repositoryRevision,
    inventorySha256: inventory.inventorySha256,
    requestSetSha256: canonicalDigest(requests),
    results,
  };
  return deepFreeze({ ...body, evidenceSha256: canonicalDigest(body) });
}

interface BatchAuthority {
  inventory: RepositoryDiscoveryInventoryV1;
  target: SearchTargetV1;
  requests: readonly RepositoryBatchProbeRequestV1[];
  privateState: PrivateInventoryState;
}

function batchAuthority(
  inventoryValue: RepositoryDiscoveryInventoryV1,
  targetValue: SearchTargetV1,
  requestValues: readonly RepositoryBatchProbeRequestV1[],
): BatchAuthority {
  if (!isPlainRecord(inventoryValue) || !authenticInventories.has(inventoryValue)) {
    throw new RepositoryInventoryError(
      "invalid-inventory",
      "Batch probes require the authentic host-produced inventory capability.",
    );
  }
  const privateState = privateInventoryStates.get(inventoryValue);
  if (!privateState) {
    throw new RepositoryInventoryError(
      "workspace-unavailable",
      "Inventory search state is unavailable.",
    );
  }
  const inventory = decodeRepositoryDiscoveryInventory(inventoryValue);
  const target = decodeSearchTarget(targetValue);
  if (target.repository.revision !== inventory.repositoryRevision) {
    throw new RepositoryInventoryError(
      "target-mismatch",
      "Inventory revision does not match search target.",
    );
  }
  const requests = normalizeProbeRequests(requestValues);
  return { inventory, target, requests, privateState };
}

function createBatchEvidence(authority: BatchAuthority): RepositoryBatchProbeEvidenceV1 {
  const results = authority.requests.map((request) =>
    answerProbe(authority.inventory, authority.target, request, authority.privateState),
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-repository-batch-probe-evidence" as const,
    targetId: authority.target.id,
    targetSha256: authority.target.targetSha256,
    repositoryRevision: authority.inventory.repositoryRevision,
    inventorySha256: authority.inventory.inventorySha256,
    requestSetSha256: canonicalDigest(authority.requests),
    results,
  };
  return deepFreeze({ ...body, evidenceSha256: canonicalDigest(body) });
}

function validateResultMappings(
  evidence: RepositoryBatchProbeEvidenceV1,
  inventory: RepositoryDiscoveryInventoryV1,
): void {
  const mappings = new Map<string, readonly string[]>(
    allPathItems(inventory).map((item) => [item.id, item.paths] as const),
  );
  for (const result of evidence.results) {
    if (result.disposition !== "found") {
      if (result.evidenceIds.length !== 0 || result.paths.length !== 0 || result.matchCount !== 0) {
        invalidProbeEvidence();
      }
      continue;
    }
    const resultPaths = new Set(result.paths);
    const mappedPaths = new Set<string>();
    for (const id of result.evidenceIds) {
      const paths = mappings.get(id);
      if (!paths || !paths.some((path) => resultPaths.has(path))) invalidProbeEvidence();
      paths.forEach((path) => mappedPaths.add(path));
    }
    if (result.paths.some((path) => !mappedPaths.has(path))) invalidProbeEvidence();
  }
}

function invalidProbeEvidence(): never {
  throw new RepositoryInventoryError(
    "invalid-inventory",
    "Repository batch probe evidence is invalid.",
  );
}

function validateInventoryNested(inventory: RepositoryDiscoveryInventoryV1): void {
  if (
    !strictlySorted(inventory.files, (item) => item.path) ||
    !strictlySorted(inventory.documents, (item) => item.path) ||
    !strictlySorted(inventory.signals, (item) => `${item.category}\0${item.name}`) ||
    !strictlySorted(inventory.commands, (item) => item.id) ||
    !strictlySorted(inventory.instructionScopes, (item) => item.path) ||
    !strictlySorted(inventory.failures, failureSortKey)
  ) {
    invalidInventory();
  }
  if (inventory.schemaVersion === 2) {
    if (
      !Array.isArray(inventory.documentProfiles) ||
      !Array.isArray(inventory.decisionFacts) ||
      !strictlySorted(inventory.documentProfiles, (item) => item.path) ||
      !strictlySorted(inventory.decisionFacts, (item) => item.topic)
    )
      invalidInventory();
  } else if (inventory.documentProfiles !== undefined || inventory.decisionFacts !== undefined) {
    invalidInventory();
  }
  exactKeys(inventory.contentIndex, [
    "status",
    "indexSha256",
    "documentCount",
    "sectionCount",
    "edgeCount",
  ]);
  if (
    (inventory.contentIndex.status !== "complete" &&
      inventory.contentIndex.status !== "incomplete") ||
    (inventory.contentIndex.indexSha256 !== null &&
      !SHA256.test(inventory.contentIndex.indexSha256)) ||
    [
      inventory.contentIndex.documentCount,
      inventory.contentIndex.sectionCount,
      inventory.contentIndex.edgeCount,
    ].some((value) => !Number.isSafeInteger(value) || value < 0) ||
    (inventory.contentIndex.status === "complete") !== (inventory.contentIndex.indexSha256 !== null)
  ) {
    invalidInventory();
  }
  const ids = new Set<string>();
  exactKeys(inventory.coverage, ["structure", "text", "navigation", "metadata"]);
  for (const kind of ["structure", "text", "navigation", "metadata"] as const) {
    const item = inventory.coverage[kind];
    exactKeys(item, [
      "policy",
      "status",
      "indexedCount",
      "excludedCount",
      "omittedCount",
      "evidenceSha256",
    ]);
    if (
      !validCoveragePolicy(kind, item.policy) ||
      (item.status !== "complete" && item.status !== "incomplete") ||
      !Number.isSafeInteger(item.indexedCount) ||
      item.indexedCount < 0 ||
      !Number.isSafeInteger(item.excludedCount) ||
      item.excludedCount < 0 ||
      !Number.isSafeInteger(item.omittedCount) ||
      item.omittedCount < 0 ||
      !SHA256.test(item.evidenceSha256) ||
      canonicalDigest({
        kind,
        policy: item.policy,
        status: item.status,
        indexedCount: item.indexedCount,
        excludedCount: item.excludedCount,
        omittedCount: item.omittedCount,
      }) !== item.evidenceSha256
    )
      invalidInventory();
  }
  for (const file of inventory.files) {
    exactKeys(file, ["id", "path", "kind", "byteLength", "evidenceSha256"]);
    safeIdentity(file.id);
    safePath(file.path);
    if (
      !new Set(["regular", "symlink", "submodule"]).has(file.kind) ||
      (file.kind === "regular"
        ? !Number.isSafeInteger(file.byteLength) || file.byteLength! < 0
        : file.byteLength !== null) ||
      canonicalDigest({
        id: file.id,
        path: file.path,
        kind: file.kind,
        byteLength: file.byteLength,
      }) !== file.evidenceSha256
    )
      invalidInventory();
    uniqueId(ids, file.id);
  }
  const navigation = inventory.navigation;
  exactKeys(navigation, [
    "id",
    "status",
    "graphEdgeCount",
    "navigationEdgeCount",
    "paths",
    ...(navigation.sources === undefined ? [] : ["sources"]),
    ...(navigation.routes === undefined ? [] : ["routes"]),
    "evidenceSha256",
  ]);
  safeIdentity(navigation.id);
  if (
    navigation.status !== inventory.coverage.navigation.status ||
    !Number.isSafeInteger(navigation.graphEdgeCount) ||
    navigation.graphEdgeCount < 0 ||
    !Number.isSafeInteger(navigation.navigationEdgeCount) ||
    navigation.navigationEdgeCount < 0 ||
    navigation.navigationEdgeCount > navigation.graphEdgeCount ||
    !strictlySorted(navigation.paths, (path) => path)
  )
    invalidInventory();
  navigation.paths.forEach(safePath);
  const navigationPaths = new Set(navigation.paths);
  for (const source of navigation.sources ?? []) {
    exactKeys(source, ["adapter", "path", "contentSha256", "evidenceSha256"]);
    safePath(source.path);
    if (
      !validNavigationAdapter(source.adapter) ||
      !SHA256.test(source.contentSha256) ||
      canonicalDigest({
        adapter: source.adapter,
        path: source.path,
        contentSha256: source.contentSha256,
      }) !== source.evidenceSha256
    )
      invalidInventory();
  }
  if (!strictlySorted(navigation.sources ?? [], (source) => `${source.adapter}\0${source.path}`))
    invalidInventory();
  for (const route of navigation.routes ?? []) {
    exactKeys(route, [
      "adapter",
      "sourcePath",
      "path",
      "route",
      "sourceSha256",
      "targetSha256",
      "evidenceSha256",
    ]);
    safePath(route.sourcePath);
    safePath(route.path);
    if (
      !validNavigationAdapter(route.adapter) ||
      (route.route !== null && !isRepositoryNavigationRoute(route.route)) ||
      !SHA256.test(route.sourceSha256) ||
      !SHA256.test(route.targetSha256) ||
      canonicalDigest({
        adapter: route.adapter,
        sourcePath: route.sourcePath,
        path: route.path,
        route: route.route,
        sourceSha256: route.sourceSha256,
        targetSha256: route.targetSha256,
      }) !== route.evidenceSha256
    )
      invalidInventory();
  }
  if (
    !strictlySorted(
      navigation.routes ?? [],
      (route) => `${route.adapter}\0${route.sourcePath}\0${route.path}\0${route.route ?? ""}`,
    ) ||
    (navigation.routes ?? []).some(
      (route) => !navigationPaths.has(route.sourcePath) || !navigationPaths.has(route.path),
    )
  )
    invalidInventory();
  if (
    canonicalDigest({
      id: navigation.id,
      status: navigation.status,
      graphEdgeCount: navigation.graphEdgeCount,
      navigationEdgeCount: navigation.navigationEdgeCount,
      paths: navigation.paths,
      ...(navigation.sources === undefined ? {} : { sources: navigation.sources }),
      ...(navigation.routes === undefined ? {} : { routes: navigation.routes }),
    }) !== navigation.evidenceSha256
  )
    invalidInventory();
  uniqueId(ids, navigation.id);
  for (const document of inventory.documents) {
    exactKeys(document, [
      "id",
      "path",
      "format",
      "depth",
      "parent",
      "candidateAudience",
      "evidenceSha256",
    ]);
    safeIdentity(document.id);
    safePath(document.path);
    if (document.parent !== null) safePath(document.parent);
    if (
      !new Set(["markdown", "gfm", "myst", "mdx", "rst"]).has(document.format) ||
      !Number.isSafeInteger(document.depth) ||
      document.depth < 0 ||
      !new Set(["public", "internal"]).has(document.candidateAudience) ||
      canonicalDigest({
        id: document.id,
        path: document.path,
        format: document.format,
        depth: document.depth,
        parent: document.parent,
        candidateAudience: document.candidateAudience,
      }) !== document.evidenceSha256
    )
      invalidInventory();
    uniqueId(ids, document.id);
  }
  for (const profile of inventory.documentProfiles ?? []) {
    exactKeys(profile, [
      "id",
      "path",
      "contentClasses",
      "byteLength",
      "sectionCount",
      "maximumSectionDepth",
      "substantiveSectionCount",
      "procedureStepCount",
      "codeBlockCount",
      "incomingRelationshipCount",
      "outgoingRelationshipCount",
      "navigationRelationshipCount",
      "evidenceSha256",
    ]);
    safeIdentity(profile.id);
    safePath(profile.path);
    const counts = [
      profile.byteLength,
      profile.sectionCount,
      profile.maximumSectionDepth,
      profile.substantiveSectionCount,
      profile.procedureStepCount,
      profile.codeBlockCount,
      profile.incomingRelationshipCount,
      profile.outgoingRelationshipCount,
      profile.navigationRelationshipCount,
    ];
    if (
      !Array.isArray(profile.contentClasses) ||
      !strictlySorted(profile.contentClasses, (item) => item) ||
      profile.contentClasses.some(
        (item) => !releaseContentClassesForPath(profile.path).includes(item),
      ) ||
      profile.contentClasses.length !== releaseContentClassesForPath(profile.path).length ||
      counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      profile.substantiveSectionCount > profile.sectionCount ||
      canonicalDigest({
        id: profile.id,
        path: profile.path,
        contentClasses: profile.contentClasses,
        byteLength: profile.byteLength,
        sectionCount: profile.sectionCount,
        maximumSectionDepth: profile.maximumSectionDepth,
        substantiveSectionCount: profile.substantiveSectionCount,
        procedureStepCount: profile.procedureStepCount,
        codeBlockCount: profile.codeBlockCount,
        incomingRelationshipCount: profile.incomingRelationshipCount,
        outgoingRelationshipCount: profile.outgoingRelationshipCount,
        navigationRelationshipCount: profile.navigationRelationshipCount,
      }) !== profile.evidenceSha256
    )
      invalidInventory();
    uniqueId(ids, profile.id);
  }
  for (const fact of inventory.decisionFacts ?? []) {
    exactKeys(fact, ["id", "topic", "status", "path", "evidenceSha256"]);
    safeIdentity(fact.id);
    if (
      !SAFE_TOKEN.test(fact.topic) ||
      (fact.status !== "approved" && fact.status !== "unknown") ||
      fact.path !== RELEASE_DECISIONS_PATH ||
      canonicalDigest({ id: fact.id, topic: fact.topic, status: fact.status, path: fact.path }) !==
        fact.evidenceSha256
    )
      invalidInventory();
    uniqueId(ids, fact.id);
  }
  for (const signalValue of inventory.signals) {
    exactKeys(signalValue, ["id", "category", "name", "paths", "evidenceSha256"]);
    safeIdentity(signalValue.id);
    if (
      !new Set(["site-generator", "ci-validation", "configuration", "dependency"]).has(
        signalValue.category,
      ) ||
      !SAFE_NAME.test(signalValue.name) ||
      !Array.isArray(signalValue.paths) ||
      signalValue.paths.length < 1 ||
      !strictlySorted(signalValue.paths, (path) => path)
    )
      invalidInventory();
    signalValue.paths.forEach(safePath);
    if (
      canonicalDigest({
        id: signalValue.id,
        category: signalValue.category,
        name: signalValue.name,
        paths: signalValue.paths,
      }) !== signalValue.evidenceSha256
    )
      invalidInventory();
    uniqueId(ids, signalValue.id);
  }
  for (const commandValue of inventory.commands) {
    exactKeys(commandValue, ["id", "purpose", "invocation", "packagePath", "evidenceSha256"]);
    safeIdentity(commandValue.id);
    safePath(commandValue.packagePath);
    if (
      !new Set(["build", "docs-build", "lint", "link-check", "test", "other"]).has(
        commandValue.purpose,
      ) ||
      !/^(?:npm|pnpm|yarn) run [A-Za-z0-9@][A-Za-z0-9._:@+/-]{0,127}$/u.test(
        commandValue.invocation,
      ) ||
      canonicalDigest({
        id: commandValue.id,
        purpose: commandValue.purpose,
        invocation: commandValue.invocation,
        packagePath: commandValue.packagePath,
      }) !== commandValue.evidenceSha256
    )
      invalidInventory();
    uniqueId(ids, commandValue.id);
  }
  for (const scope of inventory.instructionScopes) {
    exactKeys(scope, ["id", "path", "scope", "evidenceSha256"]);
    safeIdentity(scope.id);
    safePath(scope.path);
    if (scope.scope !== ".") safePath(scope.scope);
    if (
      canonicalDigest({ id: scope.id, path: scope.path, scope: scope.scope }) !==
      scope.evidenceSha256
    )
      invalidInventory();
    uniqueId(ids, scope.id);
  }
  for (const failureValue of inventory.failures) {
    exactKeys(failureValue, [
      "category",
      "affects",
      ...(failureValue.path === undefined ? [] : ["path"]),
      "evidenceSha256",
      ...(failureValue.overflow === undefined ? [] : ["overflow"]),
    ]);
    if (
      !new Set([
        "content-index-incomplete",
        "invalid-package-metadata",
        "oversize-input",
        "entry-limit-exceeded",
        "entry-redacted",
        "invalid-text-input",
        "navigation-observation-incomplete",
        "text-index-limit-exceeded",
        "tracked-file-changed",
        "tracked-file-unreadable",
        "unsafe-tracked-entry",
        "unsupported-document-format",
        "unsupported-text-format",
      ]).has(failureValue.category) ||
      !SHA256.test(failureValue.evidenceSha256) ||
      !Array.isArray(failureValue.affects) ||
      (failureValue.affects.length < 1 && failureValue.category !== "content-index-incomplete") ||
      !strictlySorted(failureValue.affects, (kind) => kind) ||
      failureValue.affects.some(
        (kind) => !new Set(["structure", "text", "navigation", "metadata"]).has(kind),
      )
    )
      invalidInventory();
    if (failureValue.path !== undefined) safePath(failureValue.path);
    if (failureValue.overflow !== undefined) {
      if (!isPlainInventoryOverflow(failureValue.overflow)) invalidInventory();
    }
  }
  for (const kind of ["structure", "text", "navigation", "metadata"] as const) {
    if (
      (inventory.coverage[kind].status === "incomplete") !==
      inventory.failures.some((item) => item.affects.includes(kind))
    )
      invalidInventory();
  }
  const filePaths = new Set(inventory.files.map((item) => item.path));
  if (
    inventory.coverage.structure.indexedCount !== inventory.files.length ||
    inventory.navigation.paths.some((path) => !filePaths.has(path)) ||
    inventory.documents.some((document) => !filePaths.has(document.path)) ||
    (inventory.documentProfiles ?? []).some((profile) => !filePaths.has(profile.path)) ||
    (inventory.decisionFacts ?? []).some((fact) => !filePaths.has(fact.path))
  )
    invalidInventory();
}

function exactKeys(value: object, allowed: readonly string[]): void {
  if (
    Object.keys(value).length !== allowed.length ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !Object.hasOwn(value, key))
  )
    invalidInventory();
}

function safeIdentity(value: string): void {
  if (!SAFE_TOKEN.test(value)) invalidInventory();
}

function uniqueId(ids: Set<string>, value: string): void {
  if (ids.has(value)) invalidInventory();
  ids.add(value);
}

function invalidInventory(): never {
  throw new RepositoryInventoryError("invalid-inventory", "Repository inventory is invalid.");
}

const { assertInert: assertInertPlainData } = createContractKit({
  fail: invalidInventory,
  inertMode: "strict",
  // An inventory grows with the tracked tree, and the generic decode ceilings
  // refused every inventory of a 10k-file tree, stopping governed search
  // (#1927). This kit's decoders (the inventory, the replay authority that
  // embeds one, and probe evidence) therefore apply no node or array ceiling.
  // repository.inventoryMaxEntries bounds the inventory only where it is
  // built, recording entry-limit-exceeded past it; depth, string, and
  // inertness checks still apply here.
  sizeGovernedBy: REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT,
  codes: {
    invalidShape: "invalid-inventory",
    invalidValue: "invalid-inventory",
    digestMismatch: "invalid-inventory",
    credentialMaterial: "invalid-inventory",
    schemaMismatch: "migration-required",
  },
});

function answerProbe(
  inventory: RepositoryDiscoveryInventoryV1,
  target: SearchTargetV1,
  request: RepositoryBatchProbeRequestV1,
  privateState: Pick<PrivateInventoryState, "searchableText">,
): RepositoryBatchProbeResultV1 {
  const requestSha256 = canonicalDigest(request);
  if (request.question.kind === "unsupported") {
    const body = {
      id: request.id,
      requestSha256,
      disposition: "unsupported" as const,
      failureCategory: "unsupported-question" as const,
      matchCount: 0,
      evidenceIds: [] as string[],
      paths: [] as string[],
    };
    return {
      ...body,
      evidenceSha256: canonicalDigest({
        inventorySha256: inventory.inventorySha256,
        targetSha256: target.targetSha256,
        requestSha256,
        result: body,
      }),
    };
  }
  const matches = matchesFor(inventory, request.question, privateState);
  const coverageKind = coverageKindFor(request.question);
  const incomplete = inventory.coverage[coverageKind].status === "incomplete";
  const disposition =
    matches.length > 0
      ? ("found" as const)
      : incomplete
        ? ("incomplete" as const)
        : ("not-found-after-bounded-search" as const);
  const evidenceIds = matches.map((match) => match.id).slice(0, MAX_RESULTS_PER_PROBE);
  const paths = [...new Set(matches.flatMap((match) => match.paths))]
    .sort()
    .slice(0, MAX_RESULTS_PER_PROBE);
  const body = {
    id: request.id,
    requestSha256,
    disposition,
    failureCategory:
      incomplete && matches.length === 0 ? incompleteFailureCategory(coverageKind) : null,
    matchCount: matches.length,
    evidenceIds,
    paths,
  };
  return {
    ...body,
    evidenceSha256: canonicalDigest({
      inventorySha256: inventory.inventorySha256,
      targetSha256: target.targetSha256,
      requestSha256,
      result: body,
    }),
  };
}

interface ProbeMatch {
  id: string;
  paths: string[];
}

function matchesFor(
  inventory: RepositoryDiscoveryInventoryV1,
  question: Exclude<RepositoryBatchProbeQuestionV1, { kind: "unsupported" }>,
  privateState: Pick<PrivateInventoryState, "searchableText">,
): ProbeMatch[] {
  if (question.kind === "filename") {
    return inventory.files.filter((item) => basename(item.path) === question.name).map(asMatch);
  }
  if (question.kind === "exact-path") {
    return inventory.files.filter((item) => item.path === question.path).map(asMatch);
  }
  if (question.kind === "path-segment") {
    return inventory.files
      .filter((item) => item.path.split("/").includes(question.segment))
      .map(asMatch);
  }
  if (question.kind === "literal-text") {
    return [...privateState.searchableText]
      .filter(([, contents]) => contents.includes(question.value))
      .map(([path]) => evidenceForPath(inventory, path))
      .filter((value): value is ProbeMatch => value !== undefined)
      .sort((left, right) => compareText(left.paths[0]!, right.paths[0]!));
  }
  if (question.kind === "document-profile") {
    return (inventory.documentProfiles ?? [])
      .filter(
        (profile) =>
          profile.contentClasses.length === 1 &&
          profile.contentClasses[0] === question.contentClass &&
          profile.byteLength >= question.minByteLength &&
          profile.sectionCount >= question.minSectionCount &&
          profile.substantiveSectionCount >= question.minSubstantiveSectionCount &&
          profile.incomingRelationshipCount + profile.outgoingRelationshipCount >=
            question.minRelationshipCount &&
          profile.procedureStepCount >= question.minProcedureStepCount &&
          profile.codeBlockCount >= question.minCodeBlockCount,
      )
      .map(asMatch);
  }
  if (question.kind === "decision-status") {
    return (inventory.decisionFacts ?? [])
      .filter((fact) => fact.topic === question.topic && fact.status === question.status)
      .map(asMatch);
  }
  if (question.field === "documentation") return inventory.documents.map(asMatch);
  if (question.field === "conventional-entrypoint") {
    return inventory.documents
      .filter((item) =>
        /^(?:README|CONTRIBUTING)(?:\.(?:md|mdx|rst))?$|^docs\/(?:README|index)(?:\.(?:md|mdx|rst))?$/iu.test(
          item.path,
        ),
      )
      .map(asMatch);
  }
  if (question.field === "site-generator")
    return inventory.signals.filter((item) => item.category === "site-generator").map(asMatch);
  if (question.field === "ci-validation")
    return inventory.signals.filter((item) => item.category === "ci-validation").map(asMatch);
  if (question.field === "instruction-scope") return inventory.instructionScopes.map(asMatch);
  if (question.field === "public-candidate")
    return inventory.documents.filter((item) => item.candidateAudience === "public").map(asMatch);
  if (question.field === "internal-candidate")
    return inventory.documents.filter((item) => item.candidateAudience === "internal").map(asMatch);
  if (question.field === "dependency")
    return inventory.signals.filter((item) => item.category === "dependency").map(asMatch);
  if (question.field === "configuration")
    return inventory.signals.filter((item) => item.category === "configuration").map(asMatch);
  if (question.field === "command") return inventory.commands.map(asMatch);
  if (question.field === "navigation-graph") {
    return inventory.navigation.navigationEdgeCount > 0 ? [asMatch(inventory.navigation)] : [];
  }
  const purpose =
    question.field === "build-command"
      ? "build"
      : question.field === "lint-command"
        ? "lint"
        : "link-check";
  return inventory.commands
    .filter(
      (item) =>
        item.purpose === purpose ||
        (question.field === "build-command" && item.purpose === "docs-build"),
    )
    .map(asMatch);
}

function allPathItems(inventory: RepositoryDiscoveryInventoryV1): ProbeMatch[] {
  return [
    ...inventory.files.map(asMatch),
    asMatch(inventory.navigation),
    ...inventory.documents.map(asMatch),
    ...inventory.signals.map(asMatch),
    ...inventory.commands.map(asMatch),
    ...inventory.instructionScopes.map(asMatch),
    ...(inventory.documentProfiles ?? []).map(asMatch),
    ...(inventory.decisionFacts ?? []).map(asMatch),
  ];
}

function asMatch(value: {
  id: string;
  path?: string;
  paths?: string[];
  packagePath?: string;
}): ProbeMatch {
  return {
    id: value.id,
    paths:
      value.paths ?? (value.path ? [value.path] : value.packagePath ? [value.packagePath] : []),
  };
}

function validateProbeRequest(request: RepositoryBatchProbeRequestV1): void {
  if (
    !isPlainRecord(request) ||
    typeof request.id !== "string" ||
    !SAFE_TOKEN.test(request.id) ||
    !isPlainRecord(request.question)
  ) {
    throw new RepositoryInventoryError("invalid-probe", "Batch probe is invalid.");
  }
  exactProbeKeys(request, ["id", "question"]);
  const question = request.question as RepositoryBatchProbeQuestionV1;
  if (question.kind === "filename") {
    exactProbeKeys(question, ["kind", "name"]);
    if (!SAFE_BASENAME.test(question.name)) invalidProbe();
    return;
  }
  if (question.kind === "exact-path") {
    exactProbeKeys(question, ["kind", "path"]);
    safePath(question.path);
    return;
  }
  if (question.kind === "path-segment") {
    exactProbeKeys(question, ["kind", "segment"]);
    if (!SAFE_BASENAME.test(question.segment)) invalidProbe();
    return;
  }
  if (question.kind === "literal-text") {
    exactProbeKeys(question, ["kind", "value"]);
    if (!isRepositoryLiteralProbeText(question.value)) {
      invalidProbe();
    }
    return;
  }
  if (question.kind === "document-profile") {
    exactProbeKeys(question, [
      "kind",
      "contentClass",
      "minByteLength",
      "minSectionCount",
      "minSubstantiveSectionCount",
      "minRelationshipCount",
      "minProcedureStepCount",
      "minCodeBlockCount",
    ]);
    const counts = [
      question.minByteLength,
      question.minSectionCount,
      question.minSubstantiveSectionCount,
      question.minRelationshipCount,
      question.minProcedureStepCount,
      question.minCodeBlockCount,
    ];
    if (
      !RELEASE_DOCUMENTATION_CONTENT_CLASSES.includes(question.contentClass) ||
      counts.some((count) => !Number.isSafeInteger(count) || count < 0 || count > 1_000_000) ||
      question.minSubstantiveSectionCount > question.minSectionCount
    )
      invalidProbe();
    return;
  }
  if (question.kind === "decision-status") {
    exactProbeKeys(question, ["kind", "topic", "status"]);
    if (!SAFE_TOKEN.test(question.topic) || question.status !== "approved") invalidProbe();
    return;
  }
  if (question.kind === "unsupported") {
    exactProbeKeys(question, ["kind", "operation"]);
    if (!new Set(["semantic-assessment", "unrestricted-pattern"]).has(question.operation)) {
      invalidProbe();
    }
    return;
  }
  const fields = new Set([
    "documentation",
    "conventional-entrypoint",
    "site-generator",
    "build-command",
    "command",
    "lint-command",
    "link-check-command",
    "ci-validation",
    "instruction-scope",
    "public-candidate",
    "internal-candidate",
    "dependency",
    "configuration",
    "navigation-graph",
  ]);
  if (question.kind !== "metadata") invalidProbe();
  exactProbeKeys(question, ["kind", "field"]);
  if (!fields.has(question.field)) invalidProbe();
}

function normalizeProbeRequests(
  values: readonly RepositoryBatchProbeRequestV1[],
): readonly RepositoryBatchProbeRequestV1[] {
  assertInertPlainData(values);
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_BATCH_PROBES) {
    throw new RepositoryInventoryError("invalid-probe", "Batch probe count is outside policy.");
  }
  const ids = new Set<string>();
  for (const value of values) {
    validateProbeRequest(value);
    if (ids.has(value.id)) invalidProbe();
    ids.add(value.id);
  }
  return deepFreeze(structuredClone(values));
}

function exactProbeKeys(value: object, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalidProbe();
}

function coverageKindFor(
  question: Exclude<RepositoryBatchProbeQuestionV1, { kind: "unsupported" }>,
): RepositoryInventoryCoverageKind {
  if (
    question.kind === "filename" ||
    question.kind === "exact-path" ||
    question.kind === "path-segment"
  )
    return "structure";
  if (question.kind === "literal-text") return "text";
  if (question.kind === "document-profile") return "navigation";
  if (question.kind === "decision-status") return "metadata";
  if (question.field === "navigation-graph") return "navigation";
  if (question.field === "documentation" || question.field === "conventional-entrypoint") {
    return "structure";
  }
  return "metadata";
}

function incompleteFailureCategory(
  kind: RepositoryInventoryCoverageKind,
): Exclude<RepositoryBatchProbeResultV1["failureCategory"], "unsupported-question" | null> {
  if (kind === "structure") return "structure-incomplete";
  if (kind === "text") return "text-index-incomplete";
  if (kind === "navigation") return "navigation-index-incomplete";
  return "metadata-index-incomplete";
}

function invalidProbe(): never {
  throw new RepositoryInventoryError("invalid-probe", "Batch probe question is outside policy.");
}

function signal(
  category: RepositoryInventorySignalV1["category"],
  name: string,
  paths: string[],
): RepositoryInventorySignalV1 {
  const body = {
    id: `signal:${canonicalDigest({ category, name, paths }).slice(0, 32)}`,
    category,
    name,
    paths,
  };
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

function command(
  purpose: RepositoryInventoryCommandV1["purpose"],
  invocation: string,
  packagePath: string,
): RepositoryInventoryCommandV1 {
  const body = {
    id: `command:${canonicalDigest({ purpose, invocation, packagePath }).slice(0, 32)}`,
    purpose,
    invocation,
    packagePath,
  };
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

function instructionScope(path: string): RepositoryInstructionScopeV1 {
  const parent = posix.dirname(path);
  const scope = parent === "." ? "." : parent;
  const body = {
    id: `instruction-scope:${canonicalDigest({ path, scope }).slice(0, 32)}`,
    path,
    scope,
  };
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

function inventoryFile(
  entry: TrackedRepositoryEntry & { path: string },
): RepositoryInventoryFileV1 {
  const body = {
    id: `file:${canonicalDigest({ path: entry.path, kind: entry.kind }).slice(0, 32)}`,
    path: entry.path,
    kind: entry.kind as RepositoryInventoryFileV1["kind"],
    byteLength: entry.byteLength ?? null,
  };
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

function coverageRecord(
  kind: RepositoryInventoryCoverageKind,
  failures: readonly RepositoryInventoryFailureV1[],
  indexedCount: number,
  excludedCount: number,
  omittedCount: number,
): RepositoryInventoryCoverageV1 {
  const body = {
    policy: coveragePolicy(kind),
    status: failures.some((item) => item.affects.includes(kind))
      ? ("incomplete" as const)
      : ("complete" as const),
    indexedCount,
    excludedCount,
    omittedCount,
  };
  return { ...body, evidenceSha256: canonicalDigest({ kind, ...body }) };
}

function coveragePolicy(
  kind: RepositoryInventoryCoverageKind,
): RepositoryInventoryCoverageV1["policy"] {
  if (kind === "structure") return "tracked-tree-v1";
  if (kind === "text") return "tracked-regular-utf8-v1";
  if (kind === "navigation") return "repository-navigation-observation-v1";
  return "repository-metadata-v1";
}

function validCoveragePolicy(
  kind: RepositoryInventoryCoverageKind,
  policy: RepositoryInventoryCoverageV1["policy"],
): boolean {
  return (
    policy === coveragePolicy(kind) || (kind === "navigation" && policy === "content-ir-graph-v2")
  );
}

function failure(
  category: RepositoryInventoryFailureCategory,
  path: string | undefined,
  detail: string,
  affects: readonly RepositoryInventoryCoverageKind[],
  overflow?: LimitOverflowObservationV1,
): RepositoryInventoryFailureV1 {
  const body = {
    category,
    affects: [...affects].sort(),
    ...(path ? { path } : {}),
    ...(overflow ? { overflow } : {}),
  };
  return {
    ...body,
    evidenceSha256: canonicalDigest({ ...body, detailSha256: canonicalDigest(detail) }),
  };
}

function isPlainInventoryOverflow(value: unknown): value is LimitOverflowObservationV1 {
  if (!isPlainRecord(value) || typeof value.limitName !== "string") return false;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "limitName" && keys !== "limitName,observed") return false;
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u.test(value.limitName)) return false;
  if (value.observed === undefined) return true;
  return (
    typeof value.observed === "number" &&
    Number.isSafeInteger(value.observed) &&
    value.observed >= 0
  );
}

function readFailure(
  error: unknown,
  path: string,
  revision: string,
  affects: readonly RepositoryInventoryCoverageKind[],
): RepositoryInventoryFailureV1 {
  if (error instanceof RepositoryWorkspaceReadError) {
    if (error.code === "oversize") return failure("oversize-input", path, revision, affects);
    if (error.code === "read-failed") {
      return failure("tracked-file-unreadable", path, revision, affects);
    }
    return failure("tracked-file-changed", path, revision, affects);
  }
  return failure("tracked-file-unreadable", path, revision, affects);
}

function evidenceForPath(
  inventory: RepositoryDiscoveryInventoryV1,
  path: string,
): ProbeMatch | undefined {
  const matches = allPathItems(inventory).filter((item) => item.paths.includes(path));
  if (matches.length === 0) return undefined;
  matches.sort((left, right) => compareText(left.id, right.id));
  return { id: matches[0]!.id, paths: [path] };
}

function strictUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/gu, "\n");
}

function documentFormat(path: string): ContentFormat | "rst" {
  if (/\.rst$/iu.test(path)) return "rst";
  if (/\.mdx$/iu.test(path)) return "mdx";
  return "gfm";
}

function audienceFor(path: string): "public" | "internal" {
  return path.split("/").some((part) => /^(?:internal|private|corp|enterprise)$/iu.test(part))
    ? "internal"
    : "public";
}

function commandPurpose(name: string): RepositoryInventoryCommandV1["purpose"] {
  const normalized = name.toLowerCase();
  if (/(?:^|:)(?:link|links|linkcheck|link-check)(?::|$)/u.test(normalized)) return "link-check";
  if (/(?:^|:)(?:lint|check)(?::|$)/u.test(normalized)) return "lint";
  if (/(?:^|:)(?:test)(?::|$)/u.test(normalized)) return "test";
  if (/^(?:docs?|site)(?::|-)?build$|^build:(?:docs?|site)$/u.test(normalized)) return "docs-build";
  if (/(?:^|:)(?:build)(?::|$)/u.test(normalized)) return "build";
  return "other";
}

type PackageManager = "npm" | "pnpm" | "yarn";

function packageManagerFor(paths: readonly string[]): PackageManager {
  if (paths.includes("pnpm-lock.yaml")) return "pnpm";
  if (paths.includes("yarn.lock")) return "yarn";
  return "npm";
}

function packageManagerInvocation(manager: PackageManager, script: string): string {
  return manager === "yarn" ? `yarn run ${script}` : `${manager} run ${script}`;
}

function dedupeSignals(values: RepositoryInventorySignalV1[]): RepositoryInventorySignalV1[] {
  const byKey = new Map<string, RepositoryInventorySignalV1>();
  for (const value of values) {
    const key = `${value.category}\0${value.name}`;
    const previous = byKey.get(key);
    byKey.set(
      key,
      previous
        ? signal(
            value.category,
            value.name,
            [...new Set([...previous.paths, ...value.paths])].sort(),
          )
        : value,
    );
  }
  return [...byKey.values()].sort(
    (left, right) =>
      compareText(left.category, right.category) || compareText(left.name, right.name),
  );
}

function dedupeCommands(values: RepositoryInventoryCommandV1[]): RepositoryInventoryCommandV1[] {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort((left, right) =>
    compareText(left.id, right.id),
  );
}

function dedupeFailures(values: RepositoryInventoryFailureV1[]): RepositoryInventoryFailureV1[] {
  return [...new Map(values.map((value) => [value.evidenceSha256, value])).values()].sort(
    (left, right) => compareText(failureSortKey(left), failureSortKey(right)),
  );
}

function failureSortKey(value: RepositoryInventoryFailureV1): string {
  return `${value.category}\0${value.path ?? ""}\0${value.affects.join(",")}\0${value.evidenceSha256}`;
}

function compareByPath(left: { path: string }, right: { path: string }): number {
  return compareText(left.path, right.path);
}

function validNavigationAdapter(value: string): boolean {
  return new Set([
    "docusaurus-json-v1",
    "fern-yaml-v1",
    "fern-versioned-yaml-v1",
    "jupyter-book-toc-v1",
    "mkdocs-yaml-v1",
  ]).has(value);
}

function strictlySorted<T>(values: readonly T[], key: (value: T) => string): boolean {
  return values.every(
    (value, index) => index === 0 || compareText(key(values[index - 1]!), key(value)) < 0,
  );
}

function inventoryPaths(inventory: RepositoryDiscoveryInventoryV1): string[] {
  return [
    ...inventory.files.map((item) => item.path),
    ...inventory.navigation.paths,
    ...inventory.documents.map((item) => item.path),
    ...inventory.signals.flatMap((item) => item.paths),
    ...inventory.commands.map((item) => item.packagePath),
    ...inventory.instructionScopes.flatMap((item) => [
      item.path,
      ...(item.scope === "." ? [] : [item.scope]),
    ]),
    ...(inventory.documentProfiles ?? []).map((item) => item.path),
    ...(inventory.decisionFacts ?? []).map((item) => item.path),
    ...inventory.failures.flatMap((item) => (item.path ? [item.path] : [])),
  ];
}

function safePath(path: unknown): asserts path is string {
  if (!isRepositoryProbePath(path)) {
    throw new RepositoryInventoryError("invalid-probe", "Repository-relative path is invalid.");
  }
}
