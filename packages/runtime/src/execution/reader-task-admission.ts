// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import { limit } from "../config/limits.js";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION,
  validateReaderContextInputV1,
  type ReaderContextComparisonV1,
  type ReaderContextInputV1,
  type ReaderContextProvenanceSourceV1,
} from "../context/reader-context.js";
import { buildRepositoryDiscoveryInventory } from "../repository/inventory.js";
import { normalizeReaderSourceHintTransportV1 } from "../reader-task-transport.js";
import { withRepositoryWorkspace } from "../repository/workspace/materialize.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
} from "../repository/workspace/contracts.js";
import {
  readTrackedRepositoryFile,
  trackedRepositoryEntryKind,
} from "../repository/workspace/tracked-read.js";
import type { ReaderComparisonRequestV1 } from "../search/change-impact.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";
import {
  ReaderTaskAdmissionObservationError,
  createReaderTaskAdmissionFailureV1,
  safeAdmissionRepositoryPath,
  type ReaderTaskAdmissionFailureReasonV1,
  type ReaderTaskAdmissionNominationBindingV1,
  type ReaderTaskAdmissionObservationErrorCode,
} from "./reader-task-admission-failure.js";
import type { ReaderTaskContextAdmissionV1 } from "./task-context.js";

export {
  ReaderTaskAdmissionObservationError,
  createReaderTaskAdmissionFailureV1,
  decodeReaderTaskAdmissionFailure,
  projectReaderTaskAdmissionFailure,
  type ReaderTaskAdmissionFailureV1,
  type ReaderTaskAdmissionObservationErrorCode,
} from "./reader-task-admission-failure.js";
import { sha256 } from "../content-ir/canonical.js";

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_RETAINED_SOURCE_BYTES = 8 * 1024 * 1024;
/**
 * Catalog name of the explicit plus change-scope nominations one admission
 * accepts; the retained request decoder and the continuation union read it too.
 */
export const READER_SOURCE_NOMINATIONS_LIMIT = "execution.readerSourceNominations";
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const GIT_BINARY = process.platform === "win32" ? "git" : "/usr/bin/git";
const SAFE_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "pager.status=false",
  "-c",
  "pager.diff=false",
] as const;

export interface ReaderTaskContextSourceBytesV1 {
  source: ReaderContextProvenanceSourceV1;
  bytes: Uint8Array;
}

/** Optional human or fixture nomination. The host supplies the digest after a confined read. */
export interface ReaderSourceHintV1 {
  role: ReaderContextProvenanceSourceV1["role"];
  path: string;
}

export interface ReaderTaskContextObservationV1 {
  admission: ReaderTaskContextAdmissionV1;
  sourceBytes: ReaderTaskContextSourceBytesV1[];
  changedPaths: string[];
  sourceBinding?: { uri: string; sha256: string };
}

export interface ReaderTaskContextNominationV1 extends ReaderSourceHintV1 {
  readonly provenance:
    | "explicit"
    | "change-scope"
    | "changed-path"
    | "repository-instruction"
    | "virtual-request";
}

interface BoundNomination extends ReaderTaskContextNominationV1 {
  readonly binding: ReaderTaskAdmissionNominationBindingV1;
  readonly bindingIndex: number;
}

function fail(code: ReaderTaskAdmissionObservationErrorCode): never {
  throw new ReaderTaskAdmissionObservationError(code); // hygiene: ok -- the error class constructs the complete stable message.
}

function failEvidenceUnavailable(
  reason: ReaderTaskAdmissionFailureReasonV1,
  selectedRevision: string,
  nomination: BoundNomination,
  disclosePath = true,
): never {
  // hygiene: ok -- the error class constructs the complete stable message.
  throw new ReaderTaskAdmissionObservationError(
    "evidence-unavailable",
    createReaderTaskAdmissionFailureV1({
      reason,
      selectedRevision,
      nomination: {
        binding: nomination.binding,
        index: nomination.bindingIndex,
        role: nomination.role,
        path: nomination.path,
        disclosePath,
      },
    }),
  );
}

const kit = createContractKit<ReaderTaskAdmissionObservationErrorCode>({
  fail: fail as ContractFail<ReaderTaskAdmissionObservationErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    credentialMaterial: "credential-material",
    digestMismatch: "identity-mismatch",
    schemaMismatch: "invalid-shape",
  },
});

/**
 * Observe one repository revision for reader-task admission. Caller-provided hints nominate a
 * role/path only; this function performs tracked reads and computes every retained digest.
 */
export async function observeReaderTaskContextAdmissionV1(input: {
  repositoryPath: string;
  revision?: string;
  observationMode: "workflow-export" | "selected-checkout";
  readerContextInput: ReaderContextInputV1;
  /** Exact operator instruction bytes, retained as request evidence without accepting a digest. */
  requestText?: string;
  comparisonRequest?: ReaderComparisonRequestV1;
  sourceHints?: readonly ReaderSourceHintV1[];
  /** Optional host policy gate over the one canonical nomination closure, before source reads. */
  admitNominations?: (nominations: readonly ReaderTaskContextNominationV1[]) => void;
  /** Hosted execution requires every changed head source to be retainable. */
  requireCompleteChangedSources?: boolean;
  /** Interactive callers may retain a missing nomination as a limitation and use valid sources. */
  onMissingSource?: (source: ReaderSourceHintV1) => void;
}): Promise<ReaderTaskContextObservationV1> {
  const readerContextInput = validateReaderContextInputV1(input.readerContextInput);
  const scopedNominations: BoundNomination[] = readerContextInput.change_scope.flatMap(
    (path, index) =>
      safeRepositoryPath(path)
        ? [
            {
              role: "current-documentation" as const,
              path,
              provenance: "change-scope" as const,
              binding: "change-scope" as const,
              bindingIndex: index,
            },
          ]
        : [],
  );
  const explicitHints: BoundNomination[] = (input.sourceHints ?? []).map((hint, index) => ({
    ...parseReaderSourceHintV1(hint),
    provenance: "explicit" as const,
    binding: "explicit-source-hint" as const,
    bindingIndex: index,
  }));
  const maxNominations = limit(READER_SOURCE_NOMINATIONS_LIMIT).value;
  if (scopedNominations.length + explicitHints.length > maxNominations) {
    fail("invalid-value");
  }
  if (input.observationMode === "selected-checkout") {
    if (input.revision !== undefined && input.revision !== "HEAD") fail("invalid-value");
    await assertSelectedCheckoutClean(input.repositoryPath);
  } else if (input.observationMode !== "workflow-export") {
    fail("invalid-value");
  }
  return withRepositoryWorkspace(
    input.repositoryPath,
    input.revision ?? "HEAD",
    async (workspace) => {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      const changedPaths =
        input.comparisonRequest?.kind === "base-head"
          ? await observeBaseHeadChangedPaths(
              workspace.sourcePath,
              input.comparisonRequest.baseRevision,
              input.comparisonRequest.headRevision,
              workspace.revision,
            )
          : [];
      const comparison = comparisonFromRequest(input.comparisonRequest, inventory.inventorySha256);
      const nominations: BoundNomination[] = [
        ...scopedNominations,
        ...changedPaths.map((path, index) => ({
          role: "changed-source" as const,
          path,
          provenance: "changed-path" as const,
          binding: "changed-path" as const,
          bindingIndex: index,
        })),
        ...explicitHints,
      ];
      const trackedPaths = new Set(
        inventory.files.filter(({ kind }) => kind === "regular").map(({ path }) => path),
      );
      const trackedTreePaths = inventory.files.map(({ path }) => path);
      for (const repositoryInstruction of ["AGENTS.md", "CLAUDE.md"]) {
        if (trackedPaths.has(repositoryInstruction)) {
          nominations.push({
            role: "repository-instruction",
            path: repositoryInstruction,
            provenance: "repository-instruction",
            binding: "repository-instruction",
            bindingIndex: 0,
          });
          break;
        }
      }
      let requestBytes: Uint8Array | undefined;
      if (input.requestText !== undefined) {
        const text = kit.string(input.requestText);
        if (
          !text.trim() ||
          text !== text.normalize("NFC") ||
          text.includes("\0") ||
          Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES
        )
          fail("invalid-value");
        requestBytes = new TextEncoder().encode(text);
        // Only DocsFab's own configured credentials stop admission (#1807); a
        // credential shape in the request is a finding in the run record.
        if (containsConfiguredCredential(text)) fail("credential-material");
      }
      input.admitNominations?.(
        Object.freeze([
          ...nominations.map(publishedNomination),
          ...(requestBytes
            ? [
                {
                  role: "request" as const,
                  path: "request:instruction",
                  provenance: "virtual-request" as const,
                },
              ]
            : []),
        ]),
      );
      const unique = new Map(
        nominations.map((nomination) => [`${nomination.role}\0${nomination.path}`, nomination]),
      );
      if (unique.size > maxNominations) fail("invalid-value");
      const sourceBytes: ReaderTaskContextSourceBytesV1[] = [];
      let retainedSourceBytes = 0;
      for (const nomination of [...unique.values()].sort((left, right) =>
        `${left.role}\0${left.path}`.localeCompare(`${right.role}\0${right.path}`),
      )) {
        let bytes: Uint8Array;
        try {
          bytes = await readTrackedRepositoryFile(workspace, nomination.path, MAX_SOURCE_BYTES);
        } catch (error) {
          if (
            input.onMissingSource &&
            nomination.provenance === "explicit" &&
            error instanceof RepositoryWorkspaceReadError &&
            error.code === "not-tracked" &&
            !(input.requireCompleteChangedSources && nomination.role === "changed-source")
          ) {
            input.onMissingSource({ role: nomination.role, path: nomination.path });
            continue;
          }
          if (
            (input.requireCompleteChangedSources && nomination.role === "changed-source") ||
            explicitHints.some(
              (hint) => hint.role === nomination.role && hint.path === nomination.path,
            )
          ) {
            await rejectRequiredNomination(workspace, nomination, error, trackedTreePaths);
          }
          continue;
        }
        if (containsConfiguredCredential(Buffer.from(bytes).toString("utf8"))) {
          fail("credential-material");
        }
        retainedSourceBytes += bytes.byteLength;
        if (retainedSourceBytes > MAX_RETAINED_SOURCE_BYTES) {
          failEvidenceUnavailable("exceeded-aggregate-byte-limit", workspace.revision, nomination);
        }
        sourceBytes.push({
          source: { uri: nomination.path, role: nomination.role, sha256: sha256(bytes) },
          bytes,
        });
      }
      if (requestBytes) {
        retainedSourceBytes += requestBytes.byteLength;
        if (retainedSourceBytes > MAX_RETAINED_SOURCE_BYTES) fail("evidence-unavailable");
        sourceBytes.push({
          source: { uri: "request:instruction", role: "request", sha256: sha256(requestBytes) },
          bytes: requestBytes,
        });
      }
      if (sourceBytes.length === 0) fail("evidence-unavailable");
      const admission: ReaderTaskContextAdmissionV1 = {
        admittedRevision: workspace.revision,
        workspaceSnapshotSha256: inventory.inventorySha256,
        repositoryIdentitySha256: sha256(new TextEncoder().encode(workspace.sourcePath)),
        comparison,
        sources: sourceBytes.map(({ source }) => source),
        provenanceLimitations:
          comparison.kind === "base-head" &&
          comparison.base_revision === comparison.head_revision &&
          !sourceBytes.some(({ source }) => source.role === "changed-source")
            ? [READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION]
            : [],
      };
      const first = sourceBytes[0]?.source;
      return {
        admission,
        sourceBytes,
        changedPaths,
        ...(first ? { sourceBinding: { uri: first.uri, sha256: first.sha256 } } : {}),
      };
    },
  );
}

function comparisonFromRequest(
  request: ReaderComparisonRequestV1 | undefined,
  workspaceSnapshotSha256: string,
): ReaderContextComparisonV1 {
  return request?.kind === "base-head"
    ? {
        kind: "base-head",
        base_revision: request.baseRevision,
        head_revision: request.headRevision,
      }
    : request?.kind === "workspace"
      ? { kind: "workspace", snapshot_sha256: workspaceSnapshotSha256 }
      : { kind: "unknown" };
}

/** Strict canonical parser shared by CLI and hosted reader-evidence transports. */
export function parseReaderSourceHintV1(value: ReaderSourceHintV1): ReaderSourceHintV1 {
  return normalizeReaderSourceHintTransportV1(value, {
    fail,
    rejectCredentials: kit.rejectCredentials,
  });
}

function publishedNomination(nomination: BoundNomination): ReaderTaskContextNominationV1 {
  return { role: nomination.role, path: nomination.path, provenance: nomination.provenance };
}

async function rejectRequiredNomination(
  workspace: RepositoryWorkspace,
  nomination: BoundNomination,
  error: unknown,
  trackedTreePaths: readonly string[],
): Promise<never> {
  const classified = await classifyRequiredReadFailure(
    workspace,
    nomination,
    error,
    trackedTreePaths,
  );
  failEvidenceUnavailable(
    classified.reason,
    workspace.revision,
    nomination,
    classified.disclosePath,
  );
}

async function classifyRequiredReadFailure(
  workspace: RepositoryWorkspace,
  nomination: BoundNomination,
  error: unknown,
  trackedTreePaths: readonly string[],
): Promise<{ reason: ReaderTaskAdmissionFailureReasonV1; disclosePath: boolean }> {
  if (!(error instanceof RepositoryWorkspaceReadError)) {
    return { reason: "unknown-read-failure", disclosePath: true };
  }
  if (error.code === "oversize") {
    return { reason: "exceeded-source-byte-limit", disclosePath: true };
  }
  if (error.code === "changed") {
    return { reason: "changed-snapshot", disclosePath: true };
  }
  if (error.code === "read-failed") {
    return { reason: "unknown-read-failure", disclosePath: true };
  }
  if (error.code === "unsafe-kind") {
    const kind = await trackedRepositoryEntryKind(workspace, nomination.path);
    if (kind === "excluded") {
      return { reason: "excluded-or-denied-source", disclosePath: false };
    }
    return { reason: "unsupported-entry-kind", disclosePath: true };
  }
  if (error.code === "not-tracked") {
    const prefix = `${nomination.path}/`;
    if (trackedTreePaths.some((path) => path.startsWith(prefix))) {
      return { reason: "unsupported-entry-kind", disclosePath: true };
    }
    return { reason: "not-admitted-at-selected-revision", disclosePath: true };
  }
  return { reason: "unknown-read-failure", disclosePath: true };
}

function safeRepositoryPath(path: string): boolean {
  return safeAdmissionRepositoryPath(path);
}

async function observeBaseHeadChangedPaths(
  repositoryPath: string,
  baseRevision: string,
  headRevision: string,
  admittedRevision: string,
): Promise<string[]> {
  if (headRevision !== admittedRevision) fail("identity-mismatch");
  const stdout = await runGit(repositoryPath, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    baseRevision,
    headRevision,
    "--",
  ]);
  const values = stdout.toString("utf8").split("\0").filter(Boolean);
  if (values.length > 10_000 || values.some((path) => !safeRepositoryPath(path))) {
    fail("invalid-value");
  }
  return [...new Set(values)].sort();
}

async function assertSelectedCheckoutClean(repositoryPath: string): Promise<void> {
  const stdout = await runGit(repositoryPath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (stdout.byteLength > 0) fail("identity-mismatch");
}

function runGit(repositoryPath: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      GIT_BINARY,
      [...SAFE_GIT_CONFIG, "-c", "credential.helper=", "-C", repositoryPath, ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.platform === "win32" ? "NUL" : "/dev/null",
          XDG_CONFIG_HOME: process.platform === "win32" ? "NUL" : "/dev/null",
          LANG: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: process.platform === "win32" ? "" : "/usr/bin/false",
          SSH_ASKPASS: process.platform === "win32" ? "" : "/usr/bin/false",
          GIT_PAGER: "cat",
          GIT_ALLOW_PROTOCOL: "file",
          LC_ALL: "C",
        },
      },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const rejectUnavailable = () => {
      if (settled) return;
      settled = true;
      reject(new ReaderTaskAdmissionObservationError("evidence-unavailable"));
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectUnavailable();
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        rejectUnavailable();
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 64 * 1024) {
        child.kill("SIGKILL");
        rejectUnavailable();
      }
    });
    child.once("error", () => {
      clearTimeout(timeout);
      rejectUnavailable();
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      if (code !== 0 || stderrBytes > 0) {
        rejectUnavailable();
        return;
      }
      settled = true;
      resolve(Buffer.concat(stdout));
    });
  });
}
