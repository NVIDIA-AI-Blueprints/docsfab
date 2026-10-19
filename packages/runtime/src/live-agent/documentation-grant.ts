// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { projectConfigBytes } from "../init/apply.js";
import { assertDocsFabProjectConfig } from "../init/project-config.js";
import { DOCSFAB_PROJECT_CONFIG_FILE, type DocsFabProjectConfigV1 } from "../init/types.js";
import {
  DOCUMENTATION_GRANT_TOOL,
  DocumentationScope,
  terminalSafeText,
} from "./documentation-scope.js";

/**
 * The roots a local run writes when `.docsfab.json` declares none. A new
 * `documentationRoots` key starts from them, because a declared list replaces
 * the defaults for workflow runs.
 */
const DEFAULT_WORKFLOW_ROOTS = ["docs", "fern"] as const;

export const DOCUMENTATION_GRANT_FAILURES = {
  readonly: "Documentation directories cannot be granted in read-only mode.",
  input:
    "Provide one repository-relative documentation directory, such as get-started, as directory.",
  ungrantable:
    "That directory cannot be granted: it is not a documentation directory DocsFab may write, such as a code, hidden, or third-party directory. Tell the user the page is read-only.",
  config:
    "The pages were granted for this session, but .docsfab.json was not changed: it is not a regular file with a valid DocsFab project configuration.",
  invalidList:
    "The pages were granted for this session, but .docsfab.json was not changed: adding the directory would make its documentationRoots invalid, for example longer than the file allows.",
  changed:
    "The pages were granted for this session, but .docsfab.json was not changed: the file changed while the user was answering. Ask the user to retry the save.",
} as const;

/**
 * Ask the operator, at the terminal, to let DocsFab edit Markdown and MDX
 * pages in a directory outside the documentation scope. The answer is the
 * grant: the model's arguments only name the directory, and no conversation
 * text can approve it. A second confirmation may save the directory to
 * `.docsfab.json` `documentationRoots`, the one file write this tool makes.
 */
export function createDocumentationGrantTool(options: {
  repositoryPath: string;
  allowWrite: boolean;
  scope: DocumentationScope;
  confirm: (message: string) => Promise<boolean>;
  /**
   * The host's direct-change gate, run before `.docsfab.json` changes: it
   * refuses after a failed workflow turn and prepares the task branch.
   */
  beforeMutation?: () => Promise<void>;
}): ToolDefinition {
  return {
    name: DOCUMENTATION_GRANT_TOOL,
    label: "Request documentation directory",
    description:
      "Ask the user at the terminal to let DocsFab edit Markdown and MDX pages in a directory outside the documentation scope. Call it before planning a change to such a page. Only the user's terminal answer grants the directory; a request to change the page is not that permission. The user may also save the directory to .docsfab.json for later sessions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["directory"],
      properties: {
        directory: {
          type: "string",
          description: "Repository-relative directory holding the pages, such as get-started.",
        },
      },
    },
    executionMode: "sequential",
    async execute(_id, raw) {
      if (!options.allowWrite) throw new Error(DOCUMENTATION_GRANT_FAILURES.readonly);
      const input = (raw ?? {}) as { directory?: unknown };
      if (
        typeof input.directory !== "string" ||
        Object.keys(input).some((key) => key !== "directory")
      )
        throw new Error(DOCUMENTATION_GRANT_FAILURES.input);
      const root = DocumentationScope.grantableRoot(input.directory);
      if (!root) throw new Error(DOCUMENTATION_GRANT_FAILURES.ungrantable);
      const directory = root.slice(0, -1);
      if (options.scope.allows(`${root}page.md`))
        return result("already-granted", `Pages under ${root} are already in the scope.`);
      const granted = await options.confirm(
        `Allow DocsFab to edit Markdown and MDX pages under ${root} for this session? Other files there stay read-only. [y/N] `,
      );
      if (!granted)
        return result(
          "declined",
          `The user declined. Pages under ${root} stay read-only; do not change them.`,
        );
      options.scope.grantForSession(directory);
      const read = await readProjectConfig(options.repositoryPath);
      if (read === "missing")
        return result(
          "granted",
          `The user granted Markdown and MDX pages under ${root} for this session. This repository has no .docsfab.json, so the grant ends with the session; docsfab init creates the file, and its documentationRoots makes the grant lasting.`,
        );
      if (read === "invalid")
        return result("granted", `${DOCUMENTATION_GRANT_FAILURES.config} Tell the user.`);
      const { config, bytes } = read;
      const roots = config.documentationRoots ?? DEFAULT_WORKFLOW_ROOTS;
      if (roots.includes(directory))
        return result(
          "granted",
          `The user granted Markdown and MDX pages under ${root} for this session. .docsfab.json already lists ${directory} in documentationRoots.`,
        );
      const next = [...roots, directory];
      const updated = { ...config, documentationRoots: next };
      try {
        assertDocsFabProjectConfig(updated);
      } catch {
        return result("granted", `${DOCUMENTATION_GRANT_FAILURES.invalidList} Tell the user.`);
      }
      // The existing roots are repository text: escape them for the terminal.
      const list = next.map((root) => terminalSafeText(root)).join(", ");
      const save = await options.confirm(
        `Also add ${directory} to documentationRoots in .docsfab.json (new list: ${list}), so later live-agent sessions and local workflow runs can edit it once you commit the file? [y/N] `,
      );
      if (!save)
        return result(
          "granted",
          `The user granted Markdown and MDX pages under ${root} for this session only. Workflow runs cannot write there.`,
        );
      try {
        await options.beforeMutation?.();
      } catch (error) {
        return result(
          "granted",
          `The pages were granted for this session, but .docsfab.json was not changed: ${error instanceof Error ? error.message : "the host refused the change."} Tell the user.`,
        );
      }
      const outcome = await writeProjectConfig(options.repositoryPath, bytes, updated).catch(
        () => "failed" as const,
      );
      if (outcome !== "written")
        return result(
          "granted",
          `${outcome === "changed" ? DOCUMENTATION_GRANT_FAILURES.changed : DOCUMENTATION_GRANT_FAILURES.config} Tell the user.`,
        );
      return result(
        "saved",
        `The user granted Markdown and MDX pages under ${root} and added ${directory} to documentationRoots in .docsfab.json (new list: ${list}). The change is uncommitted: workflow runs and later sessions use it only after the user commits it. Mention that in your reply.`,
      );
    },
  };
}

/** The working-tree project configuration, read without following a link. */
async function readProjectConfig(
  repositoryPath: string,
): Promise<{ config: DocsFabProjectConfigV1; bytes: Buffer } | "missing" | "invalid"> {
  const path = join(repositoryPath, DOCSFAB_PROJECT_CONFIG_FILE);
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata) return "missing";
  if (!metadata.isFile() || metadata.nlink !== 1) return "invalid";
  try {
    const bytes = await readFile(path);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    assertDocsFabProjectConfig(parsed);
    return { config: parsed, bytes };
  } catch {
    return "invalid";
  }
}

/**
 * Replace `.docsfab.json` through a new sibling file, so a reader never sees a
 * partial file, and only when it still holds the bytes the user was shown.
 */
async function writeProjectConfig(
  repositoryPath: string,
  expected: Buffer,
  config: DocsFabProjectConfigV1,
): Promise<"written" | "changed"> {
  const path = join(repositoryPath, DOCSFAB_PROJECT_CONFIG_FILE);
  const pending = join(repositoryPath, `.docsfab.json.${randomUUID()}.pending`);
  try {
    await writeFile(pending, projectConfigBytes(config), { flag: "wx", mode: 0o644 });
    const current = await readProjectConfig(repositoryPath);
    if (typeof current === "string" || !current.bytes.equals(expected)) return "changed";
    await rename(pending, path);
    return "written";
  } finally {
    await rm(pending, { force: true });
  }
}

function result(status: string, text: string) {
  return { content: [{ type: "text" as const, text }], details: { status } };
}
