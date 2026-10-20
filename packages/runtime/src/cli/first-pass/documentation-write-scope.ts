// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowName } from "../../workflow-contracts/contracts.js";
import type { DocumentationPlanWriteScope } from "../../workflow-execution/runner-ports.js";
import { isDocumentationResumeWorkflow } from "../knowledge-resume.js";
import { requiresOperatorNaming } from "../../repository/agent-instruction-files.js";
import {
  NO_OPERATOR_NAMED_PATHS,
  type OperatorNamedPaths,
} from "../../repository/operator-named-paths.js";
import { DEFAULT_NEXT_ACTIONS } from "../../operator/situation-catalog.js";
import { compareText } from "../../shared/primitives.js";
import {
  describeDroppedDocumentationRoots,
  DOCUMENTATION_WRITE_ROOTS,
  documentationFileRootRule,
  documentationRstUpdatePathRule,
  documentationPageShapeRule,
  documentationWriteTargetRule,
  type DocumentationRootPolicy,
  isDocumentationWriteRootUnder,
} from "../first-pass-support.js";

/**
 * Default host write set, from the one documentation write rule. Roots that
 * configuration empties are a coded refusal; only an embedder that passes
 * empty `authorizedWriteRoots` still gets the InputAsk.
 */
export const DEFAULT_DOCUMENTATION_WRITE_ROOTS = DOCUMENTATION_WRITE_ROOTS;

/**
 * First-pass write roots under a root policy. Without configured roots the
 * defaults, `docs/` and `fern/`, apply. Configured roots that are write roots
 * under `policy` replace the defaults, and the rest grant nothing and are
 * returned in `dropped`.
 * - `narrow` (the default, and hosted runs): only `docs/`, `fern/`, or a
 *   directory under one of them.
 * - `local-widen` (local runs, owner amendment to Decision 8, #1914 note
 *   72942914): any local documentation directory, such as `site/content`.
 *
 * A configured entry in `trackedFiles`, which the run's revision tracks as a
 * regular file, is a file root: returned without a trailing `/`, it grants
 * exactly that path when `documentationFileRootRule` admits it, and is dropped
 * otherwise. Every other entry is a directory root, returned ending in `/`.
 * An entry not known to be a tracked file is never a file root.
 */
export function firstPassDocumentationWriteRoots(
  configured: readonly string[] | undefined,
  policy: DocumentationRootPolicy = "narrow",
  trackedFiles: readonly string[] = [],
  rstUpdatePaths: readonly string[] = [],
): {
  readonly roots: readonly string[];
  readonly dropped: readonly string[];
} {
  if (configured === undefined) return { roots: DEFAULT_DOCUMENTATION_WRITE_ROOTS, dropped: [] };
  const files = new Set(trackedFiles);
  const withSlash = (root: string) => (root.endsWith("/") ? root : `${root}/`);
  const admitted = (root: string) =>
    files.has(root)
      ? documentationFileRootRule(root, policy) === undefined ||
        (rstUpdatePaths.includes(root) &&
          documentationRstUpdatePathRule(root, policy) === undefined)
      : isDocumentationWriteRootUnder(withSlash(root), policy);
  return {
    roots: Object.freeze(
      [
        ...new Set(
          configured.filter(admitted).map((root) => (files.has(root) ? root : withSlash(root))),
        ),
      ].sort(compareText),
    ),
    // As written in .docsfab.json, in its order, so the refusal quotes the file.
    dropped: Object.freeze(configured.filter((root) => !admitted(root))),
  };
}

/**
 * The write scope of a local run's plan, the same for every run whatever its
 * request reading, first-pass binding, or continuation: the roots above and
 * the one documentation write rule under them. Pages the request names are
 * the least a plan addresses, never all it may write. A refused path says
 * whether a root could ever hold it, so the refusal never sends the operator
 * to `documentationRoots` for a file no root admits. Inside the roots, an
 * agent instruction file or a hidden path is written only when `named`, the
 * operator's own input, names it; omitted, nothing is named.
 */
export function documentationPlanWriteScope(
  configured: readonly string[] | undefined,
  policy: DocumentationRootPolicy,
  trackedFiles: readonly string[] = [],
  named: OperatorNamedPaths = NO_OPERATOR_NAMED_PATHS,
  rstUpdatePaths: readonly string[] = [],
): DocumentationPlanWriteScope {
  const { roots } = firstPassDocumentationWriteRoots(
    configured,
    policy,
    trackedFiles,
    rstUpdatePaths,
  );
  return {
    roots,
    ...(rstUpdatePaths.length > 0 ? { rstUpdatePaths } : {}),
    rule: (path) => {
      if (rstUpdatePaths.length > 0 && !rstUpdatePaths.includes(path)) return "outside-roots";
      if (rstUpdatePaths.includes(path)) {
        const rstRule = documentationRstUpdatePathRule(path, policy);
        if (rstRule === "protected-path") return "protected";
        if (rstRule === "page-path") return "not-a-page";
        if (rstRule === "write-roots") return "outside-roots";
        return rstWriteScopeAllows(path, roots, policy) ? undefined : "outside-roots";
      }
      const broken = documentationWriteTargetRule(path, roots, policy);
      if (broken === undefined) {
        return requiresOperatorNaming(path) && !named.names(path) ? "not-named" : undefined;
      }
      if (broken === "page-path") return "not-a-page";
      if (broken === "protected-path") return "protected";
      // Outside the roots: a page some directory or file root could hold.
      return documentationPageShapeRule(path) === undefined ||
        documentationFileRootRule(path, policy) === undefined
        ? "outside-roots"
        : "protected";
    },
  };
}

export function rstWriteScopeAllows(
  path: string,
  roots: readonly string[],
  policy: DocumentationRootPolicy,
): boolean {
  return (
    documentationRstUpdatePathRule(path, policy) === undefined &&
    (roots.includes(path) || roots.some((root) => root.endsWith("/") && path.startsWith(root)))
  );
}

/**
 * The status line for configured roots that `policy` dropped, so the file
 * never narrows silently. It prints only for create and update documentation,
 * whose named and new pages the roots govern, and says only that; plan
 * admission names any planned page outside the roots. When none remains, the
 * configuration refusal follows for any named or new page.
 */
export function droppedDocumentationRootsStatus(
  workflow: WorkflowName,
  configured: readonly string[] | undefined,
  policy: DocumentationRootPolicy = "narrow",
  trackedFiles: readonly string[] = [],
): string | undefined {
  if (!isDocumentationResumeWorkflow(workflow)) return undefined;
  const { roots, dropped } = firstPassDocumentationWriteRoots(configured, policy, trackedFiles);
  if (dropped.length === 0) return undefined;
  const directories = roots.filter((root) => root.endsWith("/"));
  const files = roots.filter((root) => !root.endsWith("/"));
  const remaining =
    roots.length === 0
      ? "no named or new page can be written"
      : files.length === 0
        ? `named and new pages go only under ${directories.join(", ")}`
        : directories.length === 0
          ? `only ${files.join(", ")} can be written`
          : `named and new pages go only under ${directories.join(", ")}, and named pages also to ${files.join(", ")}`;
  // Under local widening a dropped root is unsafe, not merely elsewhere.
  const tail = policy === "local-widen" ? "" : " (#1603)";
  return `documentationRoots entries in .docsfab.json that grant no write root: ${describeDroppedDocumentationRoots(dropped, policy, trackedFiles)}; ${remaining}${tail}`;
}

/** The rule sentence for a write root, as each policy defines one. */
const WRITE_ROOT_RULE_TEXT: Readonly<Record<DocumentationRootPolicy, string>> = {
  narrow:
    'A write root is docs/, fern/, or a directory under one of them whose segments use only letters, digits, ".", "_", and "-", with no segment that starts with "." and no node_modules or vendor segment. A tracked Markdown or MDX file under docs/ or fern/ is a write root for that file alone.',
  "local-widen":
    'A write root is a directory in this repository whose segments use only letters, digits, ".", "_", and "-", with no segment that starts with "." and no node_modules or vendor segment. It cannot be packages/ itself, or be or lie in a code directory such as src/, tests/, or skills/ at the top level or under packages/<name>/. A tracked Markdown or MDX file is a write root for that file alone, unless it is hidden, under node_modules or vendor, source, CI, or an agent instruction file.',
};

/**
 * Configuration left no write root for the page a run binds. That is a
 * configuration error, and every path that binds such a page refuses it the
 * same way: a named-page proposal scope, first pass before it gathers, and a
 * create before its interpretation. Either every configured documentation
 * root is dropped, or, for a create, every one left is a file root, which
 * grants only itself and so cannot hold a new page.
 */
export class DocumentationRootsOutsideWriteRootsError extends Error {
  public readonly name = "DocumentationRootsOutsideWriteRootsError";
  public readonly code = "documentation-roots-outside-write-roots";
  public readonly retryable = false;
  public readonly nextAction = DEFAULT_NEXT_ACTIONS["documentation-roots-outside-write-roots"];

  public constructor(
    public readonly droppedRoots: readonly string[],
    policy: DocumentationRootPolicy = "narrow",
    detail: {
      /** The configured roots the revision tracks as regular files. */
      readonly trackedFiles?: readonly string[];
      /** The file roots left when a create found no directory root. */
      readonly fileRoots?: readonly string[];
    } = {},
  ) {
    const dropped =
      droppedRoots.length === 0
        ? ""
        : ` Dropped: ${describeDroppedDocumentationRoots(droppedRoots, policy, detail.trackedFiles)}.`;
    const lead =
      detail.fileRoots && detail.fileRoots.length > 0
        ? `A create writes a new page, which only a documentation directory can hold, and every documentationRoots entry in .docsfab.json that grants a write is a file: ${detail.fileRoots.join(", ")}. A file root grants only that file.${dropped}`
        : `No documentationRoots entry in .docsfab.json is a documentation write root, so DocsFab can write no named or new page in this repository.${dropped}`;
    super(
      `${lead} ${WRITE_ROOT_RULE_TEXT[policy]} Fix documentationRoots in .docsfab.json, or remove it to write under docs/ and fern/.${policy === "local-widen" ? "" : " Write roots outside docs/ and fern/ need host-sealed adapter roots (#1603)."}`,
    );
  }
}
