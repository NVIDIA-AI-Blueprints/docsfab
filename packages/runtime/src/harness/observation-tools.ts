// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Confined observation tools: section fetch from the selected workspace.
 * Scheduled by the catalog; never a public TOC job.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ToolFailureCategory } from "../records/contracts.js";
import {
  fetchDocumentationSection,
  SectionFetchError,
  type SectionFetchAuthority,
} from "../search/section-fetch.js";

export const OBSERVATION_TOOL_NAMES = ["get_section"] as const;
export type ObservationToolName = (typeof OBSERVATION_TOOL_NAMES)[number];

type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface ObservationToolOptions {
  workspacePath: string;
  repositoryRevision?: string;
  workspaceSnapshotSha256?: string;
  authority?: SectionFetchAuthority;
  /**
   * Admit `path` as `read` would: return its workspace-relative form and the
   * confined target, or throw a `SectionFetchError` (`denied-path` with the
   * refusing rule, or `not-found`) for a path `read` refuses or cannot find.
   */
  resolveReadPath: (path: string) => Promise<{ path: string; target: string }>;
  recordFailure: (category: ToolFailureCategory) => void;
}

export function createObservationToolDefinitions(
  options: ObservationToolOptions,
): AnyToolDefinition[] {
  return [wrapObservationExecute(getSectionTool(options), options.recordFailure)];
}

function getSectionTool(options: ObservationToolOptions): AnyToolDefinition {
  return {
    name: "get_section",
    label: "Get documentation section",
    description:
      "Return one bounded section of a Markdown or MDX documentation page in the selected " +
      "workspace, by repository-relative path and heading id. Navigation files are not " +
      "sections; read them with read. A refusal names its code and the call to make instead.",
    promptSnippet: "Fetch one documentation section by path and heading id",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "headingId"],
      properties: {
        path: {
          type: "string",
          description: "Repository-relative documentation path",
        },
        headingId: {
          type: "string",
          description: "Page heading anchor or Content IR section id",
        },
      },
    },
    async execute(_id, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const path = typeof params.path === "string" ? params.path : "";
      const headingId = typeof params.headingId === "string" ? params.headingId : "";
      const revision = options.repositoryRevision;
      if (!revision) {
        throw new SectionFetchError("index-unavailable"); // hygiene: ok
      }
      const resolved = await options.resolveReadPath(path);
      const result = await fetchDocumentationSection(
        {
          repositoryPath: options.workspacePath,
          repositoryRevision: revision,
          ...(options.workspaceSnapshotSha256
            ? { workspaceSnapshotSha256: options.workspaceSnapshotSha256 }
            : {}),
          path: resolved.path,
          headingId,
          resolvedPath: resolved.target,
        },
        options.authority,
      ).catch((error: unknown) => {
        // The confinement already admitted this path, so a rule-less refusal
        // from the fetch means it names no documentation page with sections,
        // such as a governed asset outside the workspace.
        if (
          error instanceof SectionFetchError &&
          error.code === "denied-path" &&
          error.pathRefusal === undefined
        ) {
          throw new SectionFetchError("not-found"); // hygiene: ok -- stable typed code; the constructor supplies the message.
        }
        throw error;
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: result.kind,
              repositoryRevision: result.repositoryRevision,
              workspaceSnapshotSha256: result.workspaceSnapshotSha256,
              path: result.path,
              headingId: result.headingId,
              sectionId: result.sectionId,
              depth: result.depth,
              startLine: result.startLine,
              endLine: result.endLine,
              byteLength: result.byteLength,
              digest: result.digest,
              bytes: result.bytes,
              evidenceSha256: result.evidenceSha256,
            }),
          },
        ],
        details: { digest: result.digest },
      };
    },
  };
}

/**
 * The closed codes a `get_section` refusal names. Each refusal says which
 * capability refused, why, and which call to make instead, so a step can
 * continue with `read` rather than stop on an unnamed unavailable tool.
 */
const GET_SECTION_REFUSAL_CODES = [
  "get-section-denied-path",
  "get-section-not-found",
  "get-section-index-unavailable",
  "get-section-snapshot-changed",
  "get-section-size-limit-exceeded",
  "get-section-withheld",
  "get-section-invalid-request",
] as const;
type GetSectionRefusalCode = (typeof GET_SECTION_REFUSAL_CODES)[number];

const GET_SECTION_REFUSAL_REMEDIATION: Readonly<Record<GetSectionRefusalCode, string>> = {
  "get-section-denied-path":
    "the path is outside what this step may read. Pass a repository-relative page path, such as docs/guide.md.",
  "get-section-not-found":
    "the path names no page in the documentation section index with a heading of that id. Read the page with read instead of retrying get_section; read also serves pages outside the index, such as navigation files, untracked files, and governed assets.",
  "get-section-index-unavailable":
    "DocsFab could not build the documentation section index for this workspace. Read documentation pages with read instead.",
  "get-section-snapshot-changed":
    "the workspace no longer matches this step's snapshot. Read the page with read instead.",
  "get-section-size-limit-exceeded":
    "the section is over the bounded section size. Request a narrower heading, or read the page with read.",
  "get-section-withheld":
    "the request arguments carried a value DocsFab withholds. Do not repeat that request.",
  "get-section-invalid-request":
    "the path or heading id is not a valid section request. Pass a repository-relative page path and one heading id.",
};

/** The refusal code for a section-fetch failure. */
function getSectionRefusalCode(error: SectionFetchError): GetSectionRefusalCode {
  switch (error.code) {
    case "denied-path":
      return "get-section-denied-path";
    case "not-found":
      return "get-section-not-found";
    case "index-unavailable":
      return "get-section-index-unavailable";
    case "snapshot-changed":
      return "get-section-snapshot-changed";
    case "size-limit-exceeded":
      return "get-section-size-limit-exceeded";
    case "credential-material":
      return "get-section-withheld";
    default:
      return "get-section-invalid-request";
  }
}

/**
 * The model-facing refusal: the tool, its closed code, the content index's
 * own code or the confinement's path rule when one refused, and the call to
 * make instead.
 */
function getSectionRefusalMessage(error: SectionFetchError): string {
  const code = getSectionRefusalCode(error);
  const cause =
    error.indexRefusal !== undefined
      ? `, content index ${error.indexRefusal}`
      : error.pathRefusal !== undefined
        ? `, path rule ${error.pathRefusal}`
        : "";
  return `DocsFab get_section refused (${code}${cause}): ${GET_SECTION_REFUSAL_REMEDIATION[code]}`;
}

function wrapObservationExecute<T extends AnyToolDefinition>(
  definition: T,
  recordFailure: (category: ToolFailureCategory) => void,
): T {
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  return {
    ...definition,
    async execute(...arguments_: any[]) {
      try {
        return await execute(...arguments_);
      } catch (error) {
        if (error instanceof SectionFetchError) {
          recordFailure(error.code === "denied-path" ? "denied-path" : "expected-missing-probe");
          throw new Error(getSectionRefusalMessage(error)); // hygiene: ok
        }
        recordFailure("tool-defect");
        throw new Error("DocsFab tool failed internally."); // hygiene: ok
      }
    },
  };
}
