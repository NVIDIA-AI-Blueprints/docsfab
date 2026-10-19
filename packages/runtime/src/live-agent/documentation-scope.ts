// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isAgentInstructionPage } from "../cli/first-pass-support.js";
import { classifyTaskWritePath } from "../execution/task-scope.js";
import {
  isSafeRepositoryRelativePath,
  isLiveAgentCodeFilePath,
  isLiveAgentConfiguredDocumentationPath,
  isLiveAgentDocumentationDirectoryRoot,
  isLiveAgentSessionDocumentationPage,
} from "./documentation-path-policy.js";
import { requiresOperatorNaming } from "../repository/agent-instruction-files.js";
import type { OperatorNamedPaths } from "../repository/operator-named-paths.js";

const DIRECTORIES = new Set(["docs", "doc", "documentation", "fern"]);
const DOC_FILE =
  /^(?:readme|changelog|contributing|authors|code_of_conduct|support)(?:\.(?:md|mdx|rst|txt))?$/iu;
const PROTECTED = new Set([
  ".git",
  ".github",
  ".gitlab",
  "node_modules",
  ".venv",
  "vendor",
  ".docsfab-governed-assets",
]);
const LAYOUT_DOCUMENT = /\.(?:mdx?|rst|txt|adoc|asciidoc|dita|ditamap|xml)$/iu;
/** The live-agent tool that asks the operator to grant a documentation directory. */
export const DOCUMENTATION_GRANT_TOOL = "docsfab_request_documentation_directory";
export const DOCUMENTATION_SCOPE_FAILURE =
  "DocsFab can change documentation paths only. Source code, CI, and unrelated configuration remain read-only.";

/** Recognized text documents in one top-level directory that the scope does not grant. */
export interface UngrantedPageDirectory {
  /** Repository-relative top-level directory, without a trailing slash. */
  readonly directory: string;
  /** Count of recognized text-document files. */
  readonly pages: number;
  /**
   * Whether `--docs-dir` or `documentationRoots` can grant it: it holds no
   * code file, and it is not a code directory a local run refuses to widen to.
   */
  readonly grantable: boolean;
}

/** What one walk of the checkout found, for operator notices and the prompt. */
export interface DocumentationLayout {
  /** Granted documentation directories found in the checkout, repository-relative. */
  readonly directories: readonly string[];
  /** Top-level directories holding recognized text-document files outside the scope, by name. */
  readonly ungranted: readonly UngrantedPageDirectory[];
  /** Recognized text-document files at the repository root outside the scope. */
  readonly rootPages: number;
}

/**
 * Host-selected scope; the model and repository instructions cannot expand it.
 * `additionalDirectories` come from `--docs-dir`. `configuredRoots` are
 * tracked `.docsfab.json` `documentationRoots` that live-agent direct tools
 * grant for eligible text documents. `configuredFiles` are tracked file roots;
 * each grants exactly that path for text editing.
 */
export class DocumentationScope {
  readonly configuredRoots: readonly string[];
  readonly configuredFiles: readonly string[];
  /** Roots the operator granted at a terminal confirmation during this session; Markdown pages only. */
  private readonly grantedRoots: string[] = [];

  constructor(
    readonly additionalDirectories: readonly string[] = [],
    configuredRoots: readonly string[] = [],
    configuredFiles: readonly string[] = [],
  ) {
    this.additionalDirectories = additionalDirectories.map((path) => {
      const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
      if (
        !isSafeRepositoryRelativePath(normalized) ||
        !isLiveAgentDocumentationDirectoryRoot(normalized)
      )
        throw new Error(
          "--docs-dir requires a repository-relative documentation directory, not the repository root, a protected path, source code, or CI.",
        );
      return normalized;
    });
    const roots = configuredRoots.map((root) => (root.endsWith("/") ? root : `${root}/`));
    if (
      roots.some((root) => !isLiveAgentDocumentationDirectoryRoot(root)) ||
      configuredFiles.some((file) => !isLiveAgentConfiguredDocumentationPath(file))
    )
      throw new Error(
        "documentationRoots in .docsfab.json may name only safe documentation directories and tracked text files.",
      );
    this.configuredRoots = roots;
    this.configuredFiles = [...configuredFiles];
  }

  allows(path: string): boolean {
    if (!isSafeRepositoryRelativePath(path)) return false;
    const parts = path.split("/");
    if (parts.some((part) => PROTECTED.has(part))) return false;
    const classification = classifyTaskWritePath(path);
    if (classification === "source" || classification === "ci") return false;
    return (
      parts.slice(0, -1).some((part) => DIRECTORIES.has(part)) ||
      (parts.length === 1 && DOC_FILE.test(path)) ||
      path.startsWith(".docsfab/reference-model/") ||
      this.additionalDirectories.some((directory) => path.startsWith(`${directory}/`)) ||
      this.configuredFiles.includes(path) ||
      this.pageRootAllows(path)
    );
  }

  /**
   * Whether a direct edit may write `path`: {@link allows}, and an agent
   * instruction file or a hidden path there only when `named`, the operator's
   * own messages, names the complete file path. A directory grant does not
   * name its descendants. DocsFab's `.docsfab/reference-model/`
   * state is no documentation root.
   */
  allowsDirectEdit(path: string, named: OperatorNamedPaths): boolean {
    if (!this.allows(path)) return false;
    if (path.startsWith(".docsfab/reference-model/")) return true;
    return !requiresOperatorNaming(path) || named.names(path);
  }

  /** Configured roots admit safe text paths; one-session grants keep the page rule. */
  private pageRootAllows(path: string): boolean {
    return (
      (this.configuredRoots.some((root) => path.startsWith(root)) &&
        isLiveAgentConfiguredDocumentationPath(path)) ||
      (this.grantedRoots.some((root) => path.startsWith(root)) &&
        isLiveAgentSessionDocumentationPage(path))
    );
  }

  /** Configured text roots grant eligible files, while established roots keep tree grants. */
  private allowsWholeTree(path: string): boolean {
    // Preserve the effective scope when subclasses narrow this session to task targets.
    if (!this.allows(`${path}/file`)) return false;
    if (
      path.split("/").some((part) => DIRECTORIES.has(part)) ||
      this.additionalDirectories.some(
        (directory) => path === directory || path.startsWith(`${directory}/`),
      )
    )
      return true;
    const configuredRootContains = this.configuredRoots.some((root) => {
      const directory = root.slice(0, -1);
      return path === directory || path.startsWith(root);
    });
    if (configuredRootContains) return false;
    return path === ".docsfab/reference-model" || path.startsWith(".docsfab/reference-model/");
  }

  /**
   * The repository-relative root, with a trailing slash, that the operator may
   * grant for `directory`, or `undefined` when no grant may reach it: the same
   * documentation-directory rule `documentationRoots` follows.
   */
  static grantableRoot(directory: string): string | undefined {
    const root = directory.endsWith("/") ? directory : `${directory}/`;
    return isLiveAgentDocumentationDirectoryRoot(root) ? root : undefined;
  }

  /**
   * Grant Markdown and MDX pages under `directory` for the rest of this
   * session. Only a host terminal confirmation calls this; the model and
   * repository text cannot.
   */
  grantForSession(directory: string): void {
    const root = DocumentationScope.grantableRoot(directory);
    if (!root) throw new Error(DOCUMENTATION_SCOPE_FAILURE);
    if (!this.grantedRoots.includes(root)) this.grantedRoots.push(root);
  }

  assert(path: string): void {
    if (!this.allows(path)) throw new Error(DOCUMENTATION_SCOPE_FAILURE);
  }

  /** The writable scope in operator words, for refusals and the prompt. */
  describe(): string {
    const added = [
      ...this.additionalDirectories.map((directory) => `${directory}/ (--docs-dir)`),
      ...this.configuredRoots.map((root) => `text documents under ${root} (.docsfab.json)`),
      ...this.configuredFiles.map((file) => `${file} (.docsfab.json, UTF-8 text editing)`),
      ...this.grantedRoots.map(
        (root) => `Markdown and MDX pages under ${root} (granted this session)`,
      ),
    ];
    return `docs/, doc/, documentation/, and fern/ directories at any depth, root README-style files, .docsfab/reference-model/${added.length ? `, and ${added.join(", ")}` : ""}`;
  }

  /** Existing writable leaves/trees for an OS command sandbox; never follow links. */
  async writablePaths(repository: string): Promise<string[]> {
    return (await this.walk(repository, true)).writable;
  }

  /**
   * Where this checkout's pages sit relative to the scope. Read-only and
   * advisory: it grants nothing, and a page it lists stays read-only.
   */
  async inspectLayout(repository: string): Promise<DocumentationLayout> {
    const { root, writable, pages } = await this.walk(repository, false);
    const directories: string[] = [];
    for (const path of writable) {
      if ((await lstat(path)).isDirectory())
        directories.push(relative(root, path).split(sep).join("/"));
    }
    // Configured roots grant pages, not whole trees, so the walk lists their
    // pages one by one; an existing configured root is still a declared layout.
    for (const configured of [...this.configuredRoots, ...this.grantedRoots]) {
      const directory = configured.slice(0, -1);
      const metadata = await lstat(join(root, directory)).catch(() => undefined);
      if (metadata?.isDirectory() && !directories.includes(directory)) directories.push(directory);
    }
    const byDirectory = new Map<string, { pages: number; code: boolean }>();
    let rootPages = 0;
    for (const page of pages.ungranted) {
      const slash = page.indexOf("/");
      if (slash === -1) {
        rootPages += 1;
        continue;
      }
      const directory = page.slice(0, slash);
      const entry = byDirectory.get(directory) ?? { pages: 0, code: false };
      entry.pages += 1;
      byDirectory.set(directory, entry);
    }
    for (const file of pages.code) {
      const entry = byDirectory.get(file.slice(0, file.indexOf("/")));
      if (entry) entry.code = true;
    }
    return {
      directories: directories.sort(),
      ungranted: [...byDirectory]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([directory, entry]) => ({
          directory,
          pages: entry.pages,
          grantable: !entry.code && isLiveAgentDocumentationDirectoryRoot(`${directory}/`),
        })),
      rootPages,
    };
  }

  /**
   * One walk of the checkout outside the granted trees. `strict` is the
   * sandbox grant: it inspects every granted tree and refuses hard links.
   */
  private async walk(repository: string, strict: boolean) {
    const root = await realpath(repository);
    const result: string[] = [];
    const ungranted: string[] = [];
    const code: string[] = [];
    let visited = 0;
    const inspectWritableTree = async (path: string): Promise<void> => {
      const metadata = await lstat(path);
      if (metadata.isFile() && metadata.nlink > 1) throw new Error(DOCUMENTATION_SCOPE_FAILURE);
      if (metadata.isDirectory()) {
        if (++visited > 20_000) throw new Error(DOCUMENTATION_SCOPE_FAILURE);
        for (const entry of await readdir(path)) await inspectWritableTree(join(path, entry));
      }
    };
    const walk = async (directory: string): Promise<void> => {
      if (++visited > 20_000)
        throw new Error(
          "Documentation directory discovery exceeded its limit. Narrow the selected repository.",
        );
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || PROTECTED.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        const path = relative(root, absolute).split(sep).join("/");
        if (entry.isDirectory()) {
          if (this.allowsWholeTree(path)) {
            if (strict) await inspectWritableTree(absolute);
            result.push(absolute);
          } else if (!entry.name.startsWith(".") || path === ".docsfab") await walk(absolute);
        } else if (entry.isFile() && this.allows(path)) {
          if (strict && (await lstat(absolute)).nlink !== 1)
            throw new Error(DOCUMENTATION_SCOPE_FAILURE);
          result.push(absolute);
        } else if (
          entry.isFile() &&
          LAYOUT_DOCUMENT.test(entry.name) &&
          !isAgentInstructionPage(path)
        ) {
          ungranted.push(path);
        } else if (entry.isFile() && isLiveAgentCodeFilePath(entry.name)) {
          code.push(path);
        }
      }
    };
    await walk(root);
    // Explicit directories can be under dot directories not traversed above.
    for (const path of this.additionalDirectories) {
      if (!this.allowsWholeTree(path)) continue;
      const absolute = resolve(root, path);
      const canonical = await realpath(absolute).catch(() => undefined);
      if (
        canonical === absolute &&
        (await lstat(absolute)).isDirectory() &&
        !result.includes(absolute)
      ) {
        if (strict) await inspectWritableTree(absolute);
        result.push(absolute);
      }
    }
    return { root, writable: result, pages: { ungranted, code } };
  }
}

/** Advice for a checkout that keeps documents outside every recognized documentation directory. */
export interface DocumentationLayoutAdvice {
  /** Where the read-only documents sit, for example `get-started/ (12 files)`. */
  readonly places: string;
  /** The finding in one sentence. */
  readonly finding: string;
  /** The grants that exist and the recommended layout, one sentence each. */
  readonly remedies: readonly string[];
}

/**
 * Advice when the checkout has no recognized documentation directory and
 * keeps recognized text documents where `--docs-dir` or `documentationRoots` could grant them, or
 * `undefined`. Repository-named directories reach the terminal escaped.
 */
export function documentationLayoutAdvice(
  layout: DocumentationLayout,
): DocumentationLayoutAdvice | undefined {
  const grantable = layout.ungranted.filter((entry) => entry.grantable);
  if (layout.directories.length > 0 || grantable.length === 0) return undefined;
  const plural = (count: number) => `${count} document${count === 1 ? "" : "s"}`;
  const places = [
    ...layout.ungranted.map((entry) => `${displayPath(entry.directory)}/ (${plural(entry.pages)})`),
    ...(layout.rootPages > 0 ? [`the repository root (${plural(layout.rootPages)})`] : []),
  ].join(", ");
  return {
    places,
    finding: `DocsFab found no recognized documentation directory (docs/, doc/, documentation/, or fern/) in this repository, so its recognized text documents in ${places} are read-only for DocsFab.`,
    remedies: [
      "Recommended: keep documentation under docs/ so DocsFab recognizes it without configuration.",
      `Or declare the directories for live-agent direct editing: set "documentationRoots": [${grantable.map((entry) => JSON.stringify(entry.directory)).join(", ")}] in .docsfab.json and commit it. The live agent can edit UTF-8 text there, including Markdown, MDX, RST, AsciiDoc, DITA, generic XML, and unfamiliar suffixes; syntax or semantic validation is reported only when a supported validator runs. Local workflow targets retain their existing format-specific rules.`,
      "Or ask the live agent for the change: it asks you at the terminal before it edits pages there, and can save the directory to .docsfab.json for you.",
      `Or grant them for one live-agent session: docsfab live-agent ${grantable.map((entry) => `--docs-dir ${shellQuote(entry.directory)}`).join(" ")}.`,
      ...(layout.rootPages > 0
        ? [
            "Pages at the repository root cannot be granted; move them into a documentation directory.",
          ]
        : []),
    ],
  };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The live-agent session-start notice for {@link documentationLayoutAdvice}. */
export function documentationLayoutNotice(layout: DocumentationLayout): string | undefined {
  const advice = documentationLayoutAdvice(layout);
  return advice && [`Documentation layout: ${advice.finding}`, ...advice.remedies].join("\n");
}

/**
 * Text that can carry repository content, with control, format (such as
 * bidirectional overrides), and line or paragraph separator characters shown
 * as escapes, so it cannot restyle or reorder the terminal.
 */
export function terminalSafeText(text: string): string {
  return text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
  );
}

/** A repository-named path with anything outside a plain path alphabet shown as an escape. */
function displayPath(path: string): string {
  return [...path]
    .map((character) =>
      /^[A-Za-z0-9_. -]$/u.test(character)
        ? character
        : `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
    )
    .join("");
}

const WIDEN_SCOPE = `To edit pages there, call ${DOCUMENTATION_GRANT_TOOL} with the page's directory: the host asks the user at the terminal, and only that answer grants it. A request to change the page is not that permission. If the directory cannot be granted, tell the user the page is read-only.`;

/** Model-facing refusal for a live-agent edit or write outside the scope. */
export function liveWriteScopeRefusal(scope: DocumentationScope): string {
  return `DocsFab denied the requested tool path. It is outside this session's documentation scope (${scope.describe()}). Every tool, including bash, refuses it, so do not retry it another way. ${WIDEN_SCOPE}`;
}

/**
 * Model-facing refusal for a direct edit of an agent instruction file or a
 * hidden path inside the scope that the operator's messages do not name.
 */
export function liveUnnamedWriteRefusal(): string {
  return "DocsFab denied the requested tool path. It is an agent instruction file, such as AGENTS.md or SKILL.md, or a hidden path, and the user's messages in this session do not name it. DocsFab edits such a file only when the user names it by its exact repository path, letter case included. Do not write it another way. If the change is needed, tell the user which file and why, and ask them to name it by its exact path.";
}

/**
 * Appended to a failed live-agent command whose output shows a refused write,
 * so the sandbox's bare "Operation not permitted" names its cause.
 */
export function liveCommandScopeNote(scope: DocumentationScope): string {
  return `DocsFab note: commands can write only inside this session's documentation scope (${scope.describe()}), Git metadata, and their private temporary directory. "Operation not permitted" or "Read-only file system" for another path is that boundary, not a file permission to change. ${WIDEN_SCOPE}`;
}

/** Output a sandbox write refusal produces: macOS `sandbox-exec` (EPERM) or Linux `bwrap` (EROFS). */
export const SANDBOX_WRITE_REFUSAL = /Operation not permitted|Read-only file system/u;
