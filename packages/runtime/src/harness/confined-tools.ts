// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, relative, sep } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolveLimitsOptions } from "../config/limits.js";
import type {
  HistoryReadCitationV1,
  MutationRefusalEntry,
  PathRefusalReason,
  ToolFailureCategory,
  ToolArgumentFillerRowV1,
  ToolFailureCategoryEntry,
  ToolRefusalsV1,
  ToolResultArchiveSnapshotV1,
} from "../records/contracts.js";
import type { WorkflowSearchPlanV1 } from "../workflow-contracts/contracts.js";
import type { RepositoryDiscoveryInventoryV1 } from "../repository/inventory.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import {
  assertConfinedToolResultCredentialFree,
  CredentialBoundaryError,
} from "../security/credential-isolation.js";
import { findConfiguredCredential } from "../security/configured-credentials.js";
import { isObservationSearchPlan } from "../search/observation-search-plan.js";
import { createCanonToolDefinitions } from "./canon-tools.js";
import { createObservationToolDefinitions } from "./observation-tools.js";
import { SectionFetchError } from "../search/section-fetch.js";
import {
  createPreservationSourceToolDefinition,
  createSourceToolDefinitions,
} from "./source-tools.js";
import {
  createCredentialSafeGrepDefinition,
  CredentialSafeGrepTransportError,
  type CredentialSafeGrepGrants,
} from "./credential-safe-grep.js";
import {
  classifyGrepFailure,
  GREP_FAILURE_CATEGORIES,
  GREP_FAILURE_MESSAGES,
} from "./grep-failure.js";
export {
  classifyGrepFailure,
  GREP_FAILURE_MESSAGES,
  type GrepFailureKind,
} from "./grep-failure.js";
import { ToolArgumentFillerLedger, ToolRefusalLedger } from "./tool-refusals.js";
import {
  createHistoryToolDefinitions,
  HistoryReadLedger,
  isHistoryToolName,
} from "./history-tools.js";
import type { GitHistoryReader } from "../repository/git-history.js";
import type { SourceStepCiterV1, SourceStepReaderV1 } from "../inputs/source-resolver.js";
import type { SourceStepSearcherV1 } from "../inputs/source-step-search.js";
import type { PreservationSourceReaderV1 } from "../workflow-execution/source-obligation.js";
import type { PreservationSourceObservationCacheV1 } from "../workflow-execution/preservation-source-observation-cache.js";
import {
  assertValidToolOutputCapBytes,
  createToolResultRecallTool,
  DEFAULT_TOOL_OUTPUT_CAP_BYTES,
  resolveToolResultArchiveLimits,
  ToolResultArchive,
  ToolResultRecallError,
  withToolOutputCap,
} from "./tool-output-cap.js";
import { QUALITY_CANDIDATE_VALIDATION_TOOL_NAME } from "./pi-tool-confine.js";
import {
  QUALITY_ANSWER_RECORD_TOOL_NAME,
  QUALITY_SUBMISSION_TOOL_NAME,
} from "./answer-submission.js";
import { type ReadEvidenceLedger, withReadEvidence } from "./read-evidence.js";
import { isRecord } from "../shared/primitives.js";
import type { ObservedSourceLinesV1 } from "../repository/source-citation.js";
import { randomUUID } from "node:crypto";
export { governedSkillVirtualRoot } from "./confined-tools/file-confinement.js";
import {
  ConfinedToolError,
  FileConfinement,
  confinedGlob,
  confinedPathForm,
  governedSkillVirtualRoot,
  isMissingPath,
  isVirtualGovernedPath,
  type PathMode,
} from "./confined-tools/file-confinement.js";
import {
  renderSourceCoordinates,
  ReviewReadCapture,
  SOURCE_LINE_MARKER,
  SourceLineLedger,
  type ReviewReadObservationSnapshot,
} from "./confined-tools/source-coordinates.js";
import {
  REVIEW_CHANGE_READ_TOOL_NAME,
  REVIEW_CHANGE_PROPOSAL_ACK,
  ReviewChangeCapture,
  type ReviewChangeObservation,
  type ReviewChangeSource,
} from "./confined-tools/review-change-side.js";

const VIRTUAL_GOVERNED_DIRECTORY = ".docsfab-governed-assets";
const FIND_PATTERN_DESCRIPTION =
  "Pattern syntax is confined: * matches zero or more characters within one path segment, " +
  "? matches exactly one character within one segment, and ** matches across directory " +
  "segments. A pattern without / matches basenames at any depth. Brace expansion, " +
  "character classes, and leading ! negation are unsupported.";
const WORKSPACE_RELATIVE_PATH =
  "Workspace-relative path. Absolute, ~, NUL, and .. segments are denied.";
/**
 * Malformed args become a refused call, not a JSON repair. The sentinel path is
 * a per-call, single-use token (Pi gives `prepareArguments` no call id and
 * clones the prepared arguments, so only a string in `path` survives to
 * `execute`). Its NUL makes `validateRawPath` deny it should the token ever
 * reach confinement unrecognised.
 */
const MALFORMED_ARGUMENT_TOKEN_PREFIX = "\0docsfab-malformed-arguments:";

const PATH_STRING = { type: "string" as const, description: WORKSPACE_RELATIVE_PATH };
const OPTIONAL_FINITE_NUMBER = {
  type: "number" as const,
  description: "Finite number; omit rather than sending a string.",
};
const OPTIONAL_POSITIVE_INTEGER = {
  type: "integer" as const,
  minimum: 1,
  description: "Positive integer; omit rather than sending a string.",
};

export type ConfinedReadTextRendering = "raw" | "source-coordinates";

/** Model-facing filesystem tool schema copy; keep it shorter and more explicit than Pi's. */
export const CONFINED_TOOL_SCHEMA_COPY = Object.freeze({
  read: {
    description:
      "Read one workspace file. path is workspace-relative. Output is capped per " +
      "call; when it is cut, a docsfab-output-cap notice names the returned byte " +
      "range and the offset to continue from.",
    promptSnippet: "Read a workspace-relative file",
    promptGuidelines: [
      "path must be workspace-relative; absolute, ~, and .. are denied.",
      "Prefer offset/limit or grep over whole-file reads; output is capped per call.",
    ],
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: PATH_STRING,
        offset: { ...OPTIONAL_POSITIVE_INTEGER, description: "1-indexed start line." },
        limit: { ...OPTIONAL_POSITIVE_INTEGER, description: "Maximum lines to return." },
      },
    },
  },
  grep: {
    description:
      "Search workspace file contents. path is workspace-relative. Output is capped " +
      "per call; when it is cut, a docsfab-output-cap notice names the returned byte range.",
    promptSnippet: "Search workspace files for a pattern",
    promptGuidelines: ["path must be workspace-relative; do not send JSON strings for booleans."],
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string" as const, description: "Literal or regex pattern." },
        path: PATH_STRING,
        glob: {
          type: "string" as const,
          description: "Optional file glob; confined find dialect.",
        },
        ignoreCase: { type: "boolean" as const, description: "Case-insensitive when true." },
        literal: { type: "boolean" as const, description: "Treat pattern as literal when true." },
        context: { ...OPTIONAL_FINITE_NUMBER, description: "Lines of context around each match." },
        limit: { ...OPTIONAL_FINITE_NUMBER, description: "Maximum matches to return." },
      },
    },
  },
  find: {
    description: `Find files. ${FIND_PATTERN_DESCRIPTION} Output is capped per call; when it is cut, a docsfab-output-cap notice names the returned byte range.`,
    promptSnippet: "Find files with confined *, **, and ? wildcard patterns",
    promptGuidelines: ["Use confined *, **, and ? only; braces, classes, and ! are unsupported."],
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string" as const,
          description: "Confined glob: *, ?, **. No braces, classes, or leading !.",
        },
        path: PATH_STRING,
        limit: { ...OPTIONAL_FINITE_NUMBER, description: "Maximum paths to return." },
      },
    },
  },
  ls: {
    description:
      "List one workspace directory. path is workspace-relative. Output is capped per " +
      "call; when it is cut, a docsfab-output-cap notice names the returned byte range.",
    promptSnippet: "List a workspace-relative directory",
    promptGuidelines: ["path must be workspace-relative; absolute, ~, and .. are denied."],
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: [],
      properties: {
        path: PATH_STRING,
        limit: { ...OPTIONAL_FINITE_NUMBER, description: "Maximum entries to return." },
      },
    },
  },
  edit: {
    description:
      "Replace exact text in one UTF-8 workspace text file, preserving its existing format. path is workspace-relative.",
    promptSnippet: "Edit a workspace-relative file with exact replacements",
    promptGuidelines: ["Send edits as an array of objects, not a JSON string."],
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["path", "edits"],
      properties: {
        path: PATH_STRING,
        edits: {
          type: "array" as const,
          description: "Exact oldText/newText pairs; not a JSON string.",
          items: {
            type: "object" as const,
            additionalProperties: false,
            required: ["oldText", "newText"],
            properties: {
              oldText: { type: "string" as const, description: "Exact original text." },
              newText: { type: "string" as const, description: "Replacement text." },
            },
          },
        },
      },
    },
  },
  write: {
    description:
      "Create or overwrite one UTF-8 workspace text file. Existing binary or invalid UTF-8 files cannot be overwritten. path is workspace-relative.",
    promptSnippet: "Write a workspace-relative file",
    promptGuidelines: ["path must be workspace-relative; write requires host --allow-write."],
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        path: PATH_STRING,
        content: { type: "string" as const, description: "Full file contents." },
      },
    },
  },
});

type FilesystemToolName = keyof typeof CONFINED_TOOL_SCHEMA_COPY;

export interface ConfinedToolOptions {
  workspacePath: string;
  governedSkill?: {
    id: string;
    directory: string;
  };
  /** Exact verified quality payload exposed read-only beside the skill. */
  governedQualityDirectory?: string;
  allowWrite: boolean;
  /** Internal worker mode; its process environment is already projected by the host. */
  credentialSafeGrepWorker?: boolean;
  /** Exact repository-relative leaves authorized for mutation. */
  allowedWritePaths?: readonly string[];
  /** Optional host policy for open-ended documentation edits, not model input. */
  isWritePathAllowed?: (path: string) => boolean;
  /**
   * Host-authored text the model receives when `isWritePathAllowed` refuses a
   * path, given that workspace-relative path, naming the scope and how the
   * operator widens it. It must begin with the generic denied-path sentence,
   * which tool evidence classifies as a denial. Read at each refusal, so a
   * scope granted later is current.
   */
  writeScopeRefusal?: (path: string) => string;
  /** Host-held canon identity; model-supplied canonJson that disagrees fails closed. */
  boundCanonSha256?: string;
  /** Full Git object id for talk-tree / get-section; omit to fail those tools closed. */
  repositoryRevision?: string;
  /** Host inventory identity bound to section evidence; omission stays visibly unbound. */
  workspaceSnapshotSha256?: string;
  /** Active non-serialized workspace capability for authenticated section bytes. */
  repositoryWorkspace?: RepositoryWorkspace;
  /** Authentic inventory object matching `workspaceSnapshotSha256`. */
  repositoryInventory?: RepositoryDiscoveryInventoryV1;
  /** Catalog search plan for this step; observation pack schedules get_section. */
  search?: WorkflowSearchPlanV1;
  /** Present only when the locked skill admitted a source read; without it no source tool. */
  sourceReader?: SourceStepReaderV1;
  /** Fresh host-issued exact-range reader over sealed restructuring originals. */
  preservationSourceReader?: PreservationSourceReaderV1;
  preservationSourceObservationCache?: PreservationSourceObservationCacheV1;
  /**
   * The runner supplies it only when the locked skill admitted a source search
   * and the host wired a page port; without it `docsfab_search_sources` is not
   * registered. A searcher without a reader registers nothing, since search
   * returns handles a read step resolves.
   */
  sourceSearcher?: SourceStepSearcherV1;
  /**
   * The runner supplies it only when the locked skill admitted source citation
   * for a write step and the host wired the citation join; without it
   * `docsfab_cite_source` is not registered.
   */
  sourceCiter?: SourceStepCiterV1;
  /**
   * Present only for a step `historyReaderForStep` admits; without it no git
   * history tool is registered.
   */
  historyReader?: GitHistoryReader;
  /**
   * Per-call model-visible payload ceiling in bytes for read/grep/find/ls and
   * the quality candidate tool; runtime config, not composition identity.
   */
  toolOutputCapBytes?: number;
  /**
   * Archive every capped original and expose `docsfab_recall_tool_result`.
   * Enable only where the session also grants the recall tool (`grantedToolsForStep`).
   */
  toolResultRecall?: boolean;
  /**
   * Attempt-scoped read-evidence ledger. When present, read-class results are
   * judged against what this attempt already delivered, outermost, so the
   * ledger sees the exact bytes the model receives.
   */
  readEvidence?: ReadEvidenceLedger;
  /** Local review-only effective artifact object bound; absent disables retention. */
  reviewReadMaxObjectBytes?: number;
  /** Private pinned source is registered only for the selected technical-review attempt. */
  reviewChangeSource?: ReviewChangeSource;
  reviewChangeRunId?: string;
  reviewChangeStepId?: string;
  /** Read only by `toolResultRecall` and the git history tools. */
  limits?: ResolveLimitsOptions;
  /** `raw` preserves Pi's read output. */
  readTextRendering?: ConfinedReadTextRendering;
  /** Exact REVIEW evaluator advisory tool admitted by the step-aware host policy. */
  qualityCandidateValidationTool?: AnyToolDefinition;
  /** The REVIEW evaluator's answer submission tool, on a route that recorded one. */
  qualitySubmissionTool?: AnyToolDefinition;
  /** Explicitly injected records-mode test route; absent in production. */
  qualityAnswerRecordTool?: AnyToolDefinition;
  /**
   * Host-held gate run once per edit/write call after the path is admitted and
   * before mutation. Disposable workflow workspaces omit it and write unguarded.
   */
  beforeMutation?: () => Promise<void>;
}

/** Host-authored refusal raised by `beforeMutation` before any file write. */
export class HostPreMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostPreMutationError";
  }
}

export interface ConfinedToolSet {
  definitions: AnyToolDefinition[];
  governedSkillVirtualPath?: string;
  governedQualityVirtualPath?: string;
  getFailureCategories(): ToolFailureCategoryEntry[];
  /** Content-free archive state; `undefined` when `toolResultRecall` was not enabled. */
  getToolResultArchive(): ToolResultArchiveSnapshotV1 | undefined;
  /** Edit/write calls refused as denied-path; a subset of that category's count. */
  getMutationBoundaryDenials(): number;
  /**
   * The same refused edit/write calls by the rule that refused each, sorted by
   * reason; the counts sum to `getMutationBoundaryDenials()`. Content-free.
   */
  getMutationRefusals(): MutationRefusalEntry[];
  /**
   * Lines each successful `read` showed the model, under `source-coordinates`
   * rendering; `undefined` under `raw`, which shows no coordinates.
   */
  getObservedSourceLines(): ObservedSourceLinesV1 | undefined;
  getReviewReadObservation(): ReviewReadObservationSnapshot | undefined;
  disposeReviewReadObservation(): void;
  getReviewChangeObservation(): ReviewChangeObservation | undefined;
  disposeReviewChangeObservation(): void;
  /** Git history pages served, in the order the calls finished; `undefined` when none was. */
  getHistoryReads(): HistoryReadCitationV1[] | undefined;
  /** Refused source and history calls, content-free; `undefined` when none was refused. */
  getToolRefusals(): ToolRefusalsV1 | undefined;
  /** Arguments set aside as filler, content-free; `undefined` when no call sent any. */
  getToolArgumentFiller(): ToolArgumentFillerRowV1[] | undefined;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * Build Pi-native tools whose filesystem boundary is the canonical workspace.
 *
 * The definitions keep Pi's built-in names. Pi registers SDK custom tools after
 * built-ins, so these replace the permissive implementations when the session
 * also uses an explicit tool allowlist.
 */
export async function createConfinedToolSet(
  options: ConfinedToolOptions,
): Promise<ConfinedToolSet> {
  const confinement = await FileConfinement.create(options);
  const capBytes = options.toolOutputCapBytes ?? DEFAULT_TOOL_OUTPUT_CAP_BYTES;
  assertValidToolOutputCapBytes(capBytes);
  const readTextRendering = options.readTextRendering ?? "raw";
  if (readTextRendering !== "raw" && readTextRendering !== "source-coordinates") {
    throw new Error("DocsFab read text rendering option must be raw or source-coordinates.");
  }
  const failures = new ToolFailureRecorder();
  const sourceLines =
    readTextRendering === "source-coordinates" ? new SourceLineLedger(confinement) : undefined;
  const reviewRead =
    readTextRendering === "source-coordinates" && options.reviewReadMaxObjectBytes !== undefined
      ? new ReviewReadCapture(confinement, options.reviewReadMaxObjectBytes)
      : undefined;
  const reviewChange =
    options.reviewChangeSource &&
    options.reviewReadMaxObjectBytes !== undefined &&
    options.reviewChangeRunId &&
    options.reviewChangeStepId
      ? new ReviewChangeCapture(
          options.reviewChangeSource,
          options.reviewChangeRunId,
          options.reviewChangeStepId,
          options.reviewReadMaxObjectBytes,
          () => reviewRead?.snapshot(),
        )
      : undefined;
  // One archive per tool set, so it lives exactly as long as its tools.
  const archive = options.toolResultRecall
    ? new ToolResultArchive(resolveToolResultArchiveLimits(options.limits))
    : undefined;
  const read = withReadTextRenderingContract(
    wrapPathInput(
      createReadToolDefinition(confinement.workspaceRoot, {
        operations: {
          access: async (path) => access(await confinement.readTarget(path)),
          readFile: async (path) => {
            const target = await confinement.readTarget(path);
            const source = await readFile(target);
            if (imageMimeType(target)) return source;
            // The whole file is screened in either rendering, so no slice of it
            // can carry part of a configured credential.
            assertRawTextCredentialFree(source);
            reviewRead?.captureRaw(target, source);
            if (readTextRendering === "raw") return source;
            return renderSourceCoordinates(source);
          },
          detectImageMimeType: async (path) => imageMimeType(await confinement.readTarget(path)),
        },
      }),
      confinement,
      failures,
      "read",
    ),
    readTextRendering,
  );
  // The historical read policy and rg child lifetime are enforced in the
  // isolated worker, including callers of the former in-process test option.
  const grepDefinition = createCredentialSafeGrepDefinition(
    confinement.workspaceRoot,
    confinement.grepReadGrants,
  );
  const grep = wrapPathInput(grepDefinition, confinement, failures, "read", ".", true);
  const findDefinition = createFindToolDefinition(confinement.workspaceRoot, {
    operations: {
      exists: async (path) => {
        try {
          await confinement.readTarget(path);
          return true;
        } catch {
          return false;
        }
      },
      glob: (pattern, cwd, globOptions) =>
        confinedGlob(confinement, pattern, cwd, globOptions.limit),
    },
  });
  const find = wrapPathInput(findDefinition, confinement, failures, "read", ".", true);
  const ls = wrapPathInput(
    createLsToolDefinition(confinement.workspaceRoot, {
      operations: {
        exists: async (path) => {
          try {
            await confinement.readTarget(path);
            return true;
          } catch {
            return false;
          }
        },
        stat: async (path) => stat(await confinement.readTarget(path)),
        readdir: async (path) => confinement.readDirectory(path),
      },
    }),
    confinement,
    failures,
    "read",
    ".",
  );

  // Every read/grep/find/ls payload is capped per call before it reaches the
  // model. The cap wraps the path confinement so it sees the exact bytes the
  // model receives.
  const definitions: AnyToolDefinition[] = [read, grep, find, ls].map((definition) =>
    withToolOutputCap(definition, capBytes, archive),
  );
  if (reviewChange) {
    if (capBytes < Buffer.byteLength(REVIEW_CHANGE_PROPOSAL_ACK)) {
      throw new Error(
        "Review anchor confirmation exceeds the configured tool output cap; raise the effective tool cap before this review.",
      );
    }
    definitions.push(withToolOutputCap(reviewChange.readTool(), capBytes, archive));
    definitions.push(withToolOutputCap(reviewChange.selectTool(), capBytes, archive));
  }
  if (archive) {
    definitions.push(recordRecallFailures(createToolResultRecallTool(archive), failures));
  }
  if (options.allowWrite) {
    const edit = wrapPathInput(
      guardSourceCoordinateMutation(
        sourceLines,
        createEditToolDefinition(confinement.workspaceRoot, {
          operations: {
            access: async (path) => access(await confinement.writeTarget(path)),
            readFile: async (path) => {
              const content = await readFile(await confinement.writeTarget(path));
              assertSupportedTextRepresentation(content);
              return content;
            },
            writeFile: async (path, content) => {
              await writeFile(
                await markedWriteTarget(confinement, sourceLines, path),
                content,
                "utf8",
              );
            },
          },
        }),
      ),
      confinement,
      failures,
      "write",
    );
    const write = wrapPathInput(
      guardSourceCoordinateMutation(
        sourceLines,
        createWriteToolDefinition(confinement.workspaceRoot, {
          operations: {
            mkdir: async (path) => {
              const target = await confinement.writeTarget(path, true);
              await mkdir(target, { recursive: true });
            },
            writeFile: async (path, content) => {
              await writeFile(
                await markedWriteTarget(confinement, sourceLines, path),
                content,
                "utf8",
              );
            },
          },
        }),
      ),
      confinement,
      failures,
      "write",
    );
    definitions.push(edit, write);
  }

  // Canon tools are always available; write grants come only from edit/write.
  definitions.push(
    ...createCanonToolDefinitions({
      recordFailure: (category) => failures.record(category),
      ...(options.boundCanonSha256 ? { boundCanonSha256: options.boundCanonSha256 } : {}),
    }),
  );
  const refusals =
    options.sourceReader || options.historyReader
      ? new ToolRefusalLedger(options.limits)
      : undefined;
  const filler =
    options.sourceReader || options.historyReader ? new ToolArgumentFillerLedger() : undefined;
  if (options.sourceReader) {
    definitions.push(
      ...createSourceToolDefinitions({
        reader: options.sourceReader,
        toolOutputCapBytes: capBytes,
        ...(refusals ? { recordRefusal: refusals.record } : {}),
        ...(filler ? { recordFiller: filler.record } : {}),
        ...(options.sourceSearcher ? { searcher: options.sourceSearcher } : {}),
        ...(options.sourceCiter ? { citer: options.sourceCiter } : {}),
        recordFailure: (category) => failures.record(category),
        // The caller's spelling as well: a root's variants come from it and its realpath.
        workspaceRoots: [
          options.workspacePath,
          confinement.workspaceRoot,
          ...(options.repositoryWorkspace ? [options.repositoryWorkspace.sourcePath] : []),
        ],
      }),
    );
  }
  if (options.preservationSourceReader) {
    definitions.push(
      createPreservationSourceToolDefinition(
        options.preservationSourceReader,
        options.preservationSourceObservationCache,
      ),
    );
  }
  const historyReads = options.historyReader ? new HistoryReadLedger() : undefined;
  if (options.historyReader) {
    definitions.push(
      ...createHistoryToolDefinitions({
        reader: options.historyReader,
        ...(refusals ? { recordRefusal: refusals.record } : {}),
        ...(filler ? { recordFiller: filler.record } : {}),
        recordFailure: (category) => failures.record(category),
        toolOutputCapBytes: capBytes,
        ...(options.limits ? { limits: options.limits } : {}),
        workspaceRoots: [
          options.workspacePath,
          confinement.workspaceRoot,
          options.historyReader.sourcePath,
        ],
      }),
    );
  }
  if (isObservationSearchPlan(options.search)) {
    definitions.push(
      ...createObservationToolDefinitions({
        workspacePath: confinement.workspaceRoot,
        resolveReadPath: async (path) => {
          let target: string;
          try {
            target = await confinement.resolveInput(path, "read");
          } catch (error) {
            if (error instanceof ConfinedToolError && error.refusal !== undefined) {
              throw new SectionFetchError("denied-path", { pathRefusal: error.refusal }); // hygiene: ok -- stable typed code; the constructor supplies the message.
            }
            if (isMissingPath(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
              throw new SectionFetchError("not-found"); // hygiene: ok -- stable typed code; the constructor supplies the message.
            }
            throw error;
          }
          // The canonical target names the page, so every form read opens (a
          // different case on a case-insensitive file system, a trailing
          // slash, a link inside the workspace) fetches the page read reads.
          // A directory or a target outside the section index is the fetch's
          // not-found.
          return { path: relative(confinement.workspaceRoot, target).split(sep).join("/"), target };
        },
        recordFailure: (category) => failures.record(category),
        ...(options.repositoryRevision ? { repositoryRevision: options.repositoryRevision } : {}),
        ...(options.workspaceSnapshotSha256
          ? { workspaceSnapshotSha256: options.workspaceSnapshotSha256 }
          : {}),
        ...(options.repositoryWorkspace && options.repositoryInventory
          ? {
              authority: {
                workspace: options.repositoryWorkspace,
                inventory: options.repositoryInventory,
              },
            }
          : {}),
      }),
    );
  }
  if (options.qualityCandidateValidationTool) {
    if (options.qualityCandidateValidationTool.name !== QUALITY_CANDIDATE_VALIDATION_TOOL_NAME) {
      throw new Error("Confined quality candidate tool has an unexpected identity.");
    }
    definitions.push(withToolOutputCap(options.qualityCandidateValidationTool, capBytes, archive));
  }
  if (options.qualitySubmissionTool) {
    if (options.qualitySubmissionTool.name !== QUALITY_SUBMISSION_TOOL_NAME) {
      throw new Error("Confined quality submission tool has an unexpected identity.");
    }
    definitions.push(withToolOutputCap(options.qualitySubmissionTool, capBytes, archive));
  }
  if (options.qualityAnswerRecordTool) {
    if (options.qualityAnswerRecordTool.name !== QUALITY_ANSWER_RECORD_TOOL_NAME) {
      throw new Error("Confined quality answer-record tool has an unexpected identity.");
    }
    definitions.push(withToolOutputCap(options.qualityAnswerRecordTool, capBytes, archive));
  }

  return {
    definitions: definitions.map((definition) => {
      // Read evidence stays the outermost wrapper, over the result screen and
      // any other per-tool wrapper, so it judges exactly the bytes the model
      // receives and never records a result a screen refused. The source-line
      // ledger sits inside it, over the result screen, so it records only a
      // result the screen passed. Read evidence replaces a result with a notice
      // only when its identical bytes are already in the attempt's context, so
      // the ledger never counts a line the model was not shown. The history
      // ledger sits at the same place for the same reason: a page the screen
      // refused is never cited.
      const screened = wrapConfinedToolResult(definition);
      const confined =
        sourceLines && definition.name === "read"
          ? sourceLines.observe(screened)
          : historyReads && isHistoryToolName(definition.name)
            ? historyReads.observe(screened)
            : screened;
      const delivered = options.readEvidence
        ? withReadEvidence(confined, options.readEvidence)
        : confined;
      if (reviewRead && definition.name === "read") return reviewRead.observe(delivered);
      if (reviewChange && definition.name === REVIEW_CHANGE_READ_TOOL_NAME)
        return reviewChange.observeDelivered(delivered);
      return delivered;
    }),
    governedSkillVirtualPath: confinement.governedSkillVirtualPath,
    governedQualityVirtualPath: confinement.governedQualityVirtualPath,
    getFailureCategories: () => failures.summary(),
    getToolResultArchive: () => archive?.snapshot(),
    getMutationBoundaryDenials: () => failures.mutationBoundaryDenials(),
    getMutationRefusals: () => failures.mutationRefusals(),
    getObservedSourceLines: () => sourceLines?.snapshot(),
    getReviewReadObservation: () => reviewRead?.snapshot(),
    disposeReviewReadObservation: () => reviewRead?.dispose(),
    getReviewChangeObservation: () => reviewChange?.snapshot(),
    disposeReviewChangeObservation: () => reviewChange?.dispose(),
    getHistoryReads: () => historyReads?.snapshot(),
    getToolRefusals: () => refusals?.snapshot(),
    getToolArgumentFiller: () => filler?.snapshot(),
  };
}

async function assertExistingTextMutationTarget(target: string): Promise<void> {
  try {
    assertSupportedTextRepresentation(await readFile(target));
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
}

function assertSupportedTextRepresentation(content: Buffer): void {
  if (content.includes(0)) {
    throw new HostPreMutationError(
      "DocsFab cannot edit this file as text because it is binary or not valid UTF-8.",
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new HostPreMutationError(
      "DocsFab cannot edit this file as text because it is binary or not valid UTF-8.",
    );
  }
}

/**
 * Attribute a refused recall to its closed failure category, keeping the
 * archive's own content-free sentence so the model knows how to recover.
 */
function recordRecallFailures(
  definition: AnyToolDefinition,
  failures: ToolFailureRecorder,
): AnyToolDefinition {
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  return {
    ...definition,
    async execute(...arguments_: any[]) {
      try {
        return await execute(...arguments_);
      } catch (error) {
        if (error instanceof ToolResultRecallError) {
          failures.record(error.category);
          throw new Error(error.message);
        }
        failures.record("tool-defect");
        throw new Error(safeFailureMessage("tool-defect"));
      }
    },
  };
}

/**
 * Screen a successful tool result for credentials. Credential-shaped bytes
 * become a content-free tool failure so they never enter the next model
 * request; the inference step may continue.
 */
function wrapConfinedToolResult<T extends AnyToolDefinition>(definition: T): T {
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  return {
    ...definition,
    async execute(...arguments_: any[]) {
      try {
        return failClosedOnCredentialShapedResult(await execute(...arguments_));
      } catch (error) {
        if (error instanceof CredentialBoundaryError) {
          throw new Error(error.message);
        }
        throw error;
      }
    },
  };
}

function failClosedOnCredentialShapedResult<T>(result: T): T {
  assertConfinedToolResultCredentialFree(result);
  return result;
}

function contentFreeToolFailure(
  error: unknown,
  failures: ToolFailureRecorder,
  toolName: string,
  mode?: PathMode,
): Error {
  if (error instanceof CredentialBoundaryError || error instanceof HostPreMutationError) {
    return new Error(error.message);
  }
  if (toolName === "grep" && error instanceof CredentialSafeGrepTransportError) {
    const transportFailure = error.failure;
    if (transportFailure.kind === "grep") {
      failures.record(GREP_FAILURE_CATEGORIES[transportFailure.grepFailureKind]);
      return new Error(GREP_FAILURE_MESSAGES[transportFailure.grepFailureKind]);
    }
    if (transportFailure.kind === "denied-path") {
      failures.record("denied-path");
      return new Error(safeFailureMessage("denied-path"));
    }
    if (transportFailure.kind === "recoverable-miss") {
      failures.record("recoverable-miss");
      return new Error("DocsFab tool target is unavailable.");
    }
    if (transportFailure.kind === "cleanup-timeout") {
      failures.record("tool-defect");
      return new Error(
        `DocsFab grep cleanup for owned process group ${transportFailure.groupId}: ${transportFailure.limitRefusal.message} Scope: ${transportFailure.scope}.`,
        { cause: transportFailure.limitRefusal },
      );
    }
    failures.record("tool-defect");
    return new Error(safeFailureMessage("tool-defect"));
  }
  const miss = recoverableMiss(toolName, error);
  if (miss !== undefined) {
    failures.record("recoverable-miss");
    return new Error(RECOVERABLE_MISS_MESSAGES[miss]);
  }
  const grepFailure = toolName === "grep" ? classifyGrepFailure(error) : undefined;
  if (grepFailure !== undefined) {
    failures.record(GREP_FAILURE_CATEGORIES[grepFailure]);
    return new Error(GREP_FAILURE_MESSAGES[grepFailure]);
  }
  const category = failureCategory(error);
  failures.record(category, error instanceof ConfinedToolError ? error.toolName : undefined);
  if (mode === "write" && error instanceof ConfinedToolError && error.refusal) {
    failures.recordMutationBoundaryDenial(error.refusal);
  }
  if (category === "malformed-arguments" && error instanceof ConfinedToolError && error.toolName) {
    return new Error(malformedArgumentsMessage(error.toolName));
  }
  if (error instanceof ConfinedToolError && error.hostMessage) return new Error(error.hostMessage);
  return new Error(safeFailureMessage(category));
}

/**
 * Remembers each malformed call's raw `path` under a single-use token, so
 * `execute` can still judge the path the model asked for.
 *
 * A token whose `execute` never runs, as in an aborted batch or a call the
 * session blocks after preparation, stays until the tool set is dropped. That
 * is one inference attempt for a workflow step, one terminal session for the
 * live agent, and one task or grant for a delegated task. Over that lifetime
 * the registry holds at most one entry per malformed call whose `execute`
 * never ran: a token and a reference to the `path` value the session's own
 * transcript already holds. It needs no eviction because a stale token can
 * only refuse: `take` matches a token, never a path, a taken token is gone,
 * every taken call is refused, and the token's NUL keeps confinement denying
 * it anywhere else.
 */
class MalformedCallRegistry {
  private readonly pending = new Map<string, unknown>();

  public register(raw: unknown): string {
    const token = `${MALFORMED_ARGUMENT_TOKEN_PREFIX}${randomUUID()}`;
    this.pending.set(token, isRecord(raw) ? raw.path : undefined);
    return token;
  }

  /** The raw path for a registered token, once; `undefined` for any other value. */
  public take(path: unknown): { rawPath: unknown } | undefined {
    if (typeof path !== "string" || !this.pending.has(path)) return undefined;
    const rawPath = this.pending.get(path);
    this.pending.delete(path);
    return { rawPath };
  }
}

/**
 * Classify a call whose arguments do not match the tool schema. It is
 * `malformed-arguments`, and so not a mutation-boundary refusal, only when the
 * path it names is a string the confinement admits for this tool's mode. A
 * missing, non-string, or refused path stays `denied-path`: the target was
 * never shown to be inside the grant. Never mutates (`prepareMutation` is not
 * called).
 */
async function refuseMalformedCall(
  toolName: string,
  rawPath: unknown,
  confinement: FileConfinement,
  mode: PathMode,
): Promise<never> {
  if (typeof rawPath !== "string") throw new ConfinedToolError("denied-path", "missing-path"); // hygiene: ok -- internal category rendered at the tool boundary
  try {
    await confinement.resolveInput(rawPath, mode);
  } catch (error) {
    // A refused path is a refusal. Any other probe failure, such as a missing
    // read target, says nothing about the grant.
    if (error instanceof ConfinedToolError) throw error;
  }
  throw new ConfinedToolError("malformed-arguments", toolName); // hygiene: ok -- internal category rendered at the tool boundary
}

function wrapPathInput<T extends AnyToolDefinition>(
  definition: T,
  confinement: FileConfinement,
  failures: ToolFailureRecorder,
  mode: PathMode,
  defaultPath?: string,
  resolveVirtualPath = false,
): T {
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  const copy = confinedSchemaCopy(definition.name);
  const malformedCalls = new MalformedCallRegistry();
  return {
    ...definition,
    ...(copy
      ? {
          description: copy.description,
          promptSnippet: copy.promptSnippet,
          promptGuidelines: [...copy.promptGuidelines],
          parameters: copy.parameters,
        }
      : {}),
    // Skip Pi's JSON-string edit repair. Malformed args pass preflight as a
    // refusal sentinel so the authorized prefix continues.
    prepareArguments(raw: unknown) {
      return filesystemArgumentsAreWellFormed(definition.name, raw)
        ? raw
        : malformedFilesystemDenySentinel(definition.name, malformedCalls.register(raw));
    },
    async execute(...arguments_: any[]) {
      try {
        const input = arguments_[1];
        if (!filesystemArgumentsAreWellFormed(definition.name, input)) {
          await refuseMalformedCall(
            definition.name,
            isRecord(input) ? (input.path ?? defaultPath) : undefined,
            confinement,
            mode,
          );
        }
        const record = input as Record<string, unknown>;
        const malformed = malformedCalls.take(record.path);
        if (malformed) {
          await refuseMalformedCall(
            definition.name,
            malformed.rawPath ?? defaultPath,
            confinement,
            mode,
          );
        }
        const rawPath = record.path ?? defaultPath;
        if (typeof rawPath !== "string") {
          throw new ConfinedToolError("denied-path", "missing-path");
        }
        const target = await confinement.resolveInput(rawPath, mode);
        // Pi normalizes the path it is handed before opening it. A path equal
        // to its judged form is one Pi leaves unchanged. Any other is handed
        // on as `./<judged form>`, which Pi also leaves unchanged (a leading
        // "@" of the judged form is not stripped again), so Pi opens exactly
        // the path the confinement judged.
        const relativePath = confinedPathForm(rawPath);
        if (resolveVirtualPath && isVirtualGovernedPath(relativePath)) {
          arguments_[1] = { ...record, path: target };
        } else if (relativePath !== rawPath) {
          arguments_[1] = { ...record, path: `./${relativePath}` };
        }
        if (mode === "write") await confinement.prepareMutation?.();
        arguments_[4] = withWorkspaceCwd(arguments_[4], confinement.workspaceRoot);
        const result = failClosedOnCredentialShapedResult(await execute(...arguments_));
        failures.recordSuccess(definition.name);
        return result;
      } catch (error) {
        throw contentFreeToolFailure(error, failures, definition.name, mode);
      }
    },
  };
}

/**
 * Pi resolves file-tool paths against `ctx.cwd`, which DocsFab keeps at the
 * virtual workspace so host paths stay out of model input. Confined tools
 * resolve against the real checkout; the other context getters stay lazy.
 */
function withWorkspaceCwd(context: unknown, workspaceRoot: string): unknown {
  if (!isRecord(context)) return context;
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(context),
      cwd: { value: workspaceRoot, enumerable: true },
    },
  );
}

function confinedSchemaCopy(name: string) {
  return name in CONFINED_TOOL_SCHEMA_COPY
    ? CONFINED_TOOL_SCHEMA_COPY[name as FilesystemToolName]
    : undefined;
}

function withReadTextRenderingContract<T extends AnyToolDefinition>(
  definition: T,
  rendering: ConfinedReadTextRendering,
): T {
  if (rendering === "raw") return definition;
  return {
    ...definition,
    description:
      `${definition.description} Text source lines have display-only [source-line N] ` +
      "coordinates; the prefixes are not file content.",
    promptGuidelines: [
      ...(definition.promptGuidelines ?? []),
      "Treat [source-line N] prefixes as display-only coordinates; exclude them from edit/write content.",
      "Images and tool metadata do not have source-line coordinates.",
    ],
  };
}

function guardSourceCoordinateMutation<T extends AnyToolDefinition>(
  ledger: SourceLineLedger | undefined,
  definition: T,
): T {
  if (!ledger) return definition;
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  return {
    ...definition,
    async execute(...arguments_: any[]) {
      const input = arguments_[1];
      const texts: unknown[] = isRecord(input)
        ? [
            input.content,
            ...(Array.isArray(input.edits)
              ? input.edits.flatMap((edit: unknown) =>
                  isRecord(edit) ? [edit.oldText, edit.newText] : [],
                )
              : []),
          ]
        : [];
      if (
        texts.some(
          (text) =>
            typeof text === "string" &&
            text.split("\n").some((segment) => SOURCE_LINE_MARKER.test(segment)),
        )
      ) {
        throw new HostPreMutationError(
          "The [source-line N] prefixes in read output are display-only coordinates, not file content. Remove them from edit and write text and call again.",
        );
      }
      return execute(...arguments_);
    },
  };
}

/**
 * The confined write target, marked mutated in the ledger first: the mark
 * names the file the bytes land in, after confinement admitted it, so a
 * refused write marks nothing.
 */
async function markedWriteTarget(
  confinement: FileConfinement,
  ledger: SourceLineLedger | undefined,
  path: string,
): Promise<string> {
  const target = await confinement.writeTarget(path);
  await assertExistingTextMutationTarget(target);
  await ledger?.markMutated(target);
  return target;
}

/** Refuse a file that holds a configured credential; a credential shape alone reads normally. */
function assertRawTextCredentialFree(source: Buffer): void {
  const match = findConfiguredCredential(source.toString("utf8"));
  if (match) {
    throw new CredentialBoundaryError("confined-tool-result", match); // hygiene: ok -- constructor renders the stable content-free boundary message
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function filesystemArgumentsAreWellFormed(name: string, raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  switch (name) {
    case "read":
      return (
        hasOnlyKeys(raw, ["path", "offset", "limit"]) &&
        typeof raw.path === "string" &&
        (raw.offset === undefined || isPositiveSafeInteger(raw.offset)) &&
        (raw.limit === undefined || isPositiveSafeInteger(raw.limit))
      );
    case "grep":
      return (
        hasOnlyKeys(raw, [
          "pattern",
          "path",
          "glob",
          "ignoreCase",
          "literal",
          "context",
          "limit",
        ]) &&
        typeof raw.pattern === "string" &&
        (raw.path === undefined || typeof raw.path === "string") &&
        (raw.glob === undefined || typeof raw.glob === "string") &&
        (raw.ignoreCase === undefined || typeof raw.ignoreCase === "boolean") &&
        (raw.literal === undefined || typeof raw.literal === "boolean") &&
        (raw.context === undefined || isFiniteNumber(raw.context)) &&
        (raw.limit === undefined || isFiniteNumber(raw.limit))
      );
    case "find":
      return (
        hasOnlyKeys(raw, ["pattern", "path", "limit"]) &&
        typeof raw.pattern === "string" &&
        (raw.path === undefined || typeof raw.path === "string") &&
        (raw.limit === undefined || isFiniteNumber(raw.limit))
      );
    case "ls":
      return (
        hasOnlyKeys(raw, ["path", "limit"]) &&
        (raw.path === undefined || typeof raw.path === "string") &&
        (raw.limit === undefined || isFiniteNumber(raw.limit))
      );
    case "edit":
      return (
        hasOnlyKeys(raw, ["path", "edits"]) &&
        typeof raw.path === "string" &&
        Array.isArray(raw.edits) &&
        raw.edits.length > 0 &&
        raw.edits.every(
          (item) =>
            isRecord(item) &&
            hasOnlyKeys(item, ["oldText", "newText"]) &&
            typeof item.oldText === "string" &&
            typeof item.newText === "string",
        )
      );
    case "write":
      return (
        hasOnlyKeys(raw, ["path", "content"]) &&
        typeof raw.path === "string" &&
        typeof raw.content === "string"
      );
    default:
      return isRecord(raw);
  }
}

function malformedFilesystemDenySentinel(name: string, token: string): Record<string, unknown> {
  switch (name) {
    case "grep":
      return { path: token, pattern: "*" };
    case "find":
      return { path: token, pattern: "*" };
    case "edit":
      return {
        path: token,
        edits: [{ oldText: "x", newText: "y" }],
      };
    case "write":
      return { path: token, content: "" };
    default:
      return { path: token };
  }
}

/**
 * Model-facing refusal for a malformed call, in the tool's own schema
 * vocabulary (`CONFINED_TOOL_SCHEMA_COPY`), so the model can resend it.
 */
export function malformedArgumentsMessage(toolName: string): string {
  const copy = confinedSchemaCopy(toolName);
  if (!copy) return safeFailureMessage("malformed-arguments");
  const required = copy.parameters.required as readonly string[];
  return (
    `DocsFab could not run ${toolName}: its arguments do not match the ${toolName} parameters. ` +
    `Send exactly ${renderSchemaShape(copy.parameters)}` +
    (required.length ? ` (required: ${required.join(", ")})` : "") +
    ", with no other keys, then call it again."
  );
}

function renderSchemaShape(schema: unknown): string {
  if (!isRecord(schema)) return "value";
  if (schema.type === "object" && isRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
    const fields = Object.entries(schema.properties).map(
      ([key, value]) =>
        `${JSON.stringify(key)}${required.includes(key) ? "" : "?"}: ${renderSchemaShape(value)}`,
    );
    return `{${fields.join(", ")}}`;
  }
  if (schema.type === "array") return `[${renderSchemaShape(schema.items)}, ...]`;
  return typeof schema.type === "string" ? schema.type : "value";
}

class ToolFailureRecorder {
  private readonly counts = new Map<ToolFailureCategory, number>();
  /** Malformed calls per tool that no later successful call of that tool has corrected. */
  private readonly uncorrectedMalformed = new Map<string, number>();
  private correctedMalformed = 0;
  private readonly refusedMutations = new Map<PathRefusalReason, number>();

  public record(category: ToolFailureCategory, toolName?: string): void {
    if (category === "malformed-arguments" && toolName) {
      this.uncorrectedMalformed.set(toolName, (this.uncorrectedMalformed.get(toolName) ?? 0) + 1);
      return;
    }
    this.counts.set(category, (this.counts.get(category) ?? 0) + 1);
  }

  /**
   * A successful call corrects every earlier malformed call to the same tool in
   * this attempt: the model resent the call in the declared shape.
   */
  public recordSuccess(toolName: string): void {
    const pending = this.uncorrectedMalformed.get(toolName) ?? 0;
    if (pending === 0) return;
    this.correctedMalformed += pending;
    this.uncorrectedMalformed.delete(toolName);
  }

  public recordMutationBoundaryDenial(reason: PathRefusalReason): void {
    this.refusedMutations.set(reason, (this.refusedMutations.get(reason) ?? 0) + 1);
  }

  public mutationBoundaryDenials(): number {
    return [...this.refusedMutations.values()].reduce((total, count) => total + count, 0);
  }

  public mutationRefusals(): MutationRefusalEntry[] {
    return [...this.refusedMutations.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => left.reason.localeCompare(right.reason));
  }

  public summary(): ToolFailureCategoryEntry[] {
    const counts = new Map(this.counts);
    const uncorrected = [...this.uncorrectedMalformed.values()].reduce(
      (total, count) => total + count,
      0,
    );
    if (uncorrected > 0) {
      counts.set("malformed-arguments", (counts.get("malformed-arguments") ?? 0) + uncorrected);
    }
    if (this.correctedMalformed > 0) {
      counts.set("malformed-arguments-corrected", this.correctedMalformed);
    }
    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((left, right) => left.category.localeCompare(right.category));
  }
}

function failureCategory(error: unknown): ToolFailureCategory {
  if (error instanceof ConfinedToolError) return error.category;
  if (isMissingPath(error)) return "expected-missing-probe";
  return "tool-defect";
}

/**
 * Model-facing sentence per `recoverable-miss` kind. Pi's own messages can
 * name a host path, so the model gets these instead; none names a path or
 * file content.
 */
export const RECOVERABLE_MISS_MESSAGES = Object.freeze({
  "edit-text-not-found":
    "DocsFab could not apply the edit: an oldText does not occur in the file exactly as sent. Read the file again and resend oldText exactly as it appears, including whitespace and line breaks.",
  "edit-text-not-unique":
    "DocsFab could not apply the edit: an oldText occurs more than once in the file. Include enough surrounding text that each oldText matches exactly one place.",
  "edit-text-empty":
    "DocsFab could not apply the edit: an oldText is empty. Send the exact text to replace.",
  "edit-overlap":
    "DocsFab could not apply the edit: two oldText regions overlap. Merge nearby changes into one edit.",
  "edit-no-change": "DocsFab could not apply the edit: the replacement leaves the file unchanged.",
  "edit-missing-file":
    "DocsFab could not apply the edit: the file does not exist. Use write to create a new file.",
  "read-past-end":
    "DocsFab could not read from that offset: it is past the end of the file. Read again with a smaller offset.",
  "directory-not-file": "DocsFab could not run the tool: the path is a directory, not a file.",
  "file-not-directory":
    "DocsFab could not run the tool: the path, or a segment of it, is a file, not a directory.",
} as const);

export type RecoverableMissKind = keyof typeof RECOVERABLE_MISS_MESSAGES;

/**
 * Pi's refusals (pinned `@earendil-works/pi-coding-agent`) of a call whose
 * target did not match what it asked for, per tool. Each is raised before any
 * write; a message these do not match stays `tool-defect`.
 */
const PI_MISS_MESSAGES: Readonly<
  Record<string, readonly (readonly [RegExp, RecoverableMissKind])[]>
> = Object.freeze({
  edit: [
    [
      /^Could not find (?:the exact text|edits\[\d+\]) in [\s\S]+\. The (?:old text|oldText) must match exactly including all whitespace and newlines\.$/u,
      "edit-text-not-found",
    ],
    [
      /^Found \d+ occurrences of (?:the text|edits\[\d+\]) in [\s\S]+\. (?:The text|Each oldText) must be unique\. Please provide more context to make it unique\.$/u,
      "edit-text-not-unique",
    ],
    [/^(?:edits\[\d+\]\.)?oldText must not be empty in [\s\S]+\.$/u, "edit-text-empty"],
    [
      /^edits\[\d+\] and edits\[\d+\] overlap in [\s\S]+\. Merge them into one edit or target disjoint regions\.$/u,
      "edit-overlap",
    ],
    [
      /^No changes made to [\s\S]+\. The replacements? produced identical content\.(?: This might indicate an issue with special characters or the text not existing as expected\.)?$/u,
      "edit-no-change",
    ],
    [/^Could not edit file: [\s\S]+\. Error code: ENOENT\.$/u, "edit-missing-file"],
  ],
  read: [[/^Offset \d+ is beyond end of file \(\d+ lines total\)$/u, "read-past-end"]],
  ls: [[/^Not a directory: [\s\S]+$/u, "file-not-directory"]],
});

/**
 * The `recoverable-miss` kind of a failed call, or `undefined`. A filesystem
 * `EISDIR` or `ENOTDIR` names the path's kind; Pi's own refusals carry no
 * code, so they are matched per tool. A confinement refusal is never a miss.
 */
function recoverableMiss(toolName: string, error: unknown): RecoverableMissKind | undefined {
  if (!(error instanceof Error) || error instanceof ConfinedToolError) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EISDIR") return "directory-not-file";
  if (code === "ENOTDIR") return "file-not-directory";
  if (code !== undefined) return undefined;
  return PI_MISS_MESSAGES[toolName]?.find(([pattern]) => pattern.test(error.message))?.[1];
}

/** Operator-safe sentence per failure category; exported so tests can assert the set is closed. */
export function safeFailureMessage(category: ToolFailureCategory): string {
  switch (category) {
    case "expected-missing-probe":
      return "DocsFab tool target is unavailable.";
    case "denied-path":
      return "DocsFab denied the requested tool path.";
    case "malformed-arguments":
    case "malformed-arguments-corrected":
      return "DocsFab could not run the tool: its arguments do not match the tool's declared parameters.";
    case "unsupported-pattern":
      return "DocsFab does not support the requested tool pattern.";
    case "citation-refused":
      return "DocsFab refused the requested source citation.";
    case "recoverable-miss":
      return "DocsFab could not run the tool: its target does not match the call. Check the path and text, then call it again.";
    case "tool-defect":
      return "DocsFab tool failed internally.";
  }
}

function imageMimeType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return undefined;
  }
}
