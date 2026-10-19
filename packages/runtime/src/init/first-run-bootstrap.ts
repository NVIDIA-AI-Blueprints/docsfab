// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * First-run project configuration: host-derived, credential-free, and never
 * standing authority. A local, nonpublishing write can use default roots
 * without project setup; requests that need setup propose it in the workspace.
 * Untracked files and invalid tracked config cannot authorize the run.
 */
import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  resolveProjectConfigAuthority,
  type ProjectConfigAuthority,
} from "../project-config-preflight.js";
import {
  createContractKit,
  type ContractFail,
  type ContractKit,
  type SealedEnvelope,
} from "../contract-kit/index.js";
import { projectConfigBytes } from "./apply.js";
import {
  documentationFileRootRule,
  documentationPageShapeRule,
  documentationWriteTargetRule,
  type DocumentationRootPolicy,
  type DocumentationWriteTargetRule,
} from "../cli/first-pass-support.js";
import {
  captureRepositoryApprovalIdentity,
  discoverRepository,
  inspectGitLab,
  selectCanonicalRemote,
} from "./gitlab-probe.js";
import { assertDocsFabProjectConfig } from "./project-config.js";
import { ExecInitCommandRunner, assertCredentialFree, credentialFree } from "./shared.js";
import { compareText } from "../shared/primitives.js";
import {
  DOCSFAB_PROJECT_CONFIG_FILE,
  type CommandRunner,
  type DocsFabInitPrompt,
  type DocsFabProjectConfigV1,
} from "./types.js";

export interface HostDerivedProjectConfig {
  readonly projectConfig: DocsFabProjectConfigV1;
  readonly repositoryBindingSha256: string;
}

interface FirstRunProposalScopeBody {
  readonly workflow: "create-documentation" | "update-documentation";
  readonly instructionSha256: string;
  readonly repositoryRevision: string;
  readonly targetPaths: readonly string[];
}

export type FirstRunProposalScopeBinding = SealedEnvelope<
  "docsfab-first-run-proposal-scope",
  "bodySha256",
  FirstRunProposalScopeBody
>;

export class FirstRunProposalScopeError extends Error {
  public constructor(
    public readonly code: FirstRunProposalScopeErrorCode,
    message: string,
    public readonly instructionSha256?: string,
    public readonly repositoryRevision?: string,
  ) {
    super(message);
    this.name = "FirstRunProposalScopeError";
  }

  public readonly phase = "proposal-scope-admission" as const;
  public readonly retryable = false as const;
  public readonly noWorkPerformed = true as const;
}

export type FirstRunProjectConfigResult =
  | { readonly status: "tracked"; readonly config: DocsFabProjectConfigV1 }
  | { readonly status: "skipped" }
  | { readonly status: "local-unconfigured" }
  | ({ readonly status: "host-private" } & HostDerivedProjectConfig)
  | ({ readonly status: "bootstrapped" } & HostDerivedProjectConfig);

const PROPOSAL_SCOPE_KIND = "docsfab-first-run-proposal-scope";
export type FirstRunProposalScopeErrorCode =
  | "proposal-scope-input-invalid"
  | "proposal-scope-unsafe-target"
  | "proposal-scope-ambiguous-targets"
  | "proposal-scope-duplicate-targets"
  | "proposal-scope-conflicting-targets"
  | "proposal-scope-binding-mismatch"
  | "proposal-scope-excludes-project-config"
  | "proposal-scope-non-actionable-targets"
  | "migration-required";
const proposalInputKit = proposalContractKit("proposal-scope-input-invalid");
const proposalBindingKit = proposalContractKit("proposal-scope-binding-mismatch");

export function createFirstRunProposalScopeBinding(input: {
  readonly workflow: "create-documentation" | "update-documentation";
  readonly instructionSha256: string;
  readonly repositoryRevision: string;
  readonly targetPaths: readonly string[];
}): FirstRunProposalScopeBinding {
  proposalInputKit.assertInert(input);
  proposalInputKit.rejectCredentials(input);
  proposalInputKit.exact(proposalInputKit.object(input), [
    "workflow",
    "instructionSha256",
    "repositoryRevision",
    "targetPaths",
  ]);
  return proposalInputKit.seal(
    PROPOSAL_SCOPE_KIND,
    "bodySha256",
    normalizeProposalScopeBody(input, proposalInputKit, "proposal-scope-input-invalid"),
  );
}

export function assertFirstRunProposalScopeBinding(
  binding: FirstRunProposalScopeBinding,
  expected: {
    readonly workflow: "create-documentation" | "update-documentation";
    readonly instructionSha256: string;
    readonly repositoryRevision: string;
  },
): FirstRunProposalScopeBinding {
  const decoded = proposalBindingKit.decodeSealed(
    binding,
    PROPOSAL_SCOPE_KIND,
    "bodySha256",
    ["workflow", "instructionSha256", "repositoryRevision", "targetPaths"],
    (root) =>
      normalizeProposalScopeBody(root, proposalBindingKit, "proposal-scope-binding-mismatch"),
  );
  if (
    decoded.workflow !== expected.workflow ||
    decoded.instructionSha256 !== expected.instructionSha256 ||
    decoded.repositoryRevision !== expected.repositoryRevision
  ) {
    rejectFirstRunProposalScope("proposal-scope-binding-mismatch");
  }
  return decoded;
}

function proposalContractKit(code: FirstRunProposalScopeErrorCode) {
  return createContractKit({
    fail: rejectFirstRunProposalScope as ContractFail<FirstRunProposalScopeErrorCode>,
    codes: {
      invalidShape: code,
      invalidValue: code,
      digestMismatch: code,
      credentialMaterial: code,
      schemaMismatch: "migration-required",
    },
    inertMode: "strict",
  });
}

function normalizeProposalScopeBody(
  value: unknown,
  kit: ContractKit<FirstRunProposalScopeErrorCode>,
  invalidCode: FirstRunProposalScopeErrorCode,
): FirstRunProposalScopeBody {
  const root = kit.object(value);
  kit.exact(root, ["workflow", "instructionSha256", "repositoryRevision", "targetPaths"]);
  const targetPaths = kit.array(root.targetPaths).map(kit.string).sort(kit.compare);
  kit.unique(targetPaths);
  const workflow = kit.enumeration(root.workflow, [
    "create-documentation",
    "update-documentation",
  ] as const);
  // The sealed grammar is the page shape any write root allows, a directory
  // root's page or a file root's own page; admission already applied the
  // project's roots before sealing.
  if (
    targetPaths.length < 1 ||
    targetPaths.some(
      (path) =>
        path !== DOCSFAB_PROJECT_CONFIG_FILE &&
        !(
          workflow === "update-documentation" &&
          path.endsWith(".rst") &&
          (documentationPageShapeRule(`${path.slice(0, -4)}.md`) === undefined ||
            documentationFileRootRule(`${path.slice(0, -4)}.md`, "local-widen") === undefined)
        ) &&
        documentationPageShapeRule(path) !== undefined &&
        documentationFileRootRule(path, "local-widen") !== undefined,
    )
  ) {
    kit.fail(invalidCode);
  }
  return {
    workflow,
    instructionSha256: kit.hash(root.instructionSha256),
    repositoryRevision: kit.revision(root.repositoryRevision),
    targetPaths,
  };
}

/**
 * Fixed, content-free proposal-scope refusals. Exported so a surface that only
 * receives the message across a tool boundary can recover the code by exact
 * match instead of guessing from free text. A refusal that names its pages
 * uses an exact form {@link proposalScopeFailureCode} also recognizes.
 */
export const FIRST_RUN_PROPOSAL_SCOPE_FAILURES: Readonly<
  Record<FirstRunProposalScopeErrorCode, string>
> = Object.freeze({
  "proposal-scope-input-invalid": "The explicit proposal scope has an invalid shape or value.",
  "proposal-scope-unsafe-target":
    "The explicit proposal scope contains an unsafe documentation target.",
  "proposal-scope-ambiguous-targets":
    "The documentation request does not identify an unambiguous output target list.",
  "proposal-scope-duplicate-targets":
    "The documentation output list names the same target more than once.",
  "proposal-scope-conflicting-targets":
    "The documentation output list conflicts with a read dependency or change-only restriction.",
  "proposal-scope-binding-mismatch":
    "The explicit proposal scope does not match the workflow, instruction, or repository revision.",
  "proposal-scope-excludes-project-config":
    "The explicit proposal scope excludes .docsfab.json, but this execution path requires that exported project configuration. Amend the request to name .docsfab.json.",
  "proposal-scope-non-actionable-targets":
    "The documentation request names its pages only in a question, a deferral, or a request not to change them.",
  "migration-required": "The explicit proposal scope uses an incompatible schema version or kind.",
});

export function rejectFirstRunProposalScope(
  code: FirstRunProposalScopeErrorCode,
  context: {
    readonly instructionSha256?: string;
    readonly repositoryRevision?: string;
  } = {},
): never {
  throw new FirstRunProposalScopeError(
    code,
    FIRST_RUN_PROPOSAL_SCOPE_FAILURES[code],
    context.instructionSha256,
    context.repositoryRevision,
  );
}

/** A named page the documentation write rule refuses, and the rule it breaks. */
export interface RefusedDocumentationTarget {
  readonly path: string;
  readonly rule: DocumentationWriteTargetRule;
}

/**
 * Refuse named pages the documentation write rule does not admit. The message
 * names each page and the rule it breaks, and points pages in other
 * documentation trees to #1603. An unsafe path such as `docs/../x.md` is never
 * echoed: a refusal that holds one, or a message carrying credential material,
 * gets the fixed refusal instead.
 */
export function rejectDocumentationTargets(
  refused: readonly RefusedDocumentationTarget[],
  roots: readonly string[],
  context: {
    readonly instructionSha256?: string;
    readonly repositoryRevision?: string;
  } = {},
  policy: DocumentationRootPolicy = "narrow",
): never {
  // hygiene: ok -- the typed code accompanies a complete message that names each refused page.
  throw new FirstRunProposalScopeError(
    "proposal-scope-unsafe-target",
    printableMessage(unadmittedTargetsMessage(refused, roots, policy)) ??
      FIRST_RUN_PROPOSAL_SCOPE_FAILURES["proposal-scope-unsafe-target"],
    context.instructionSha256,
    context.repositoryRevision,
  );
}

/** Refuse a request that names a page more than once, naming each repeated page. */
export function rejectRepeatedDocumentationTargets(
  paths: readonly string[],
  context: {
    readonly instructionSha256?: string;
    readonly repositoryRevision?: string;
  } = {},
): never {
  // hygiene: ok -- the typed code accompanies a complete message that names each repeated page.
  throw new FirstRunProposalScopeError(
    "proposal-scope-duplicate-targets",
    printableMessage(repeatedTargetsMessage(paths)) ??
      FIRST_RUN_PROPOSAL_SCOPE_FAILURES["proposal-scope-duplicate-targets"],
    context.instructionSha256,
    context.repositoryRevision,
  );
}

// The messages that name pages have one exact grammar each. The builders and
// the patterns that recognize their output share these parts.
const PATH_PATTERN = "[A-Za-z0-9_./-]+";
/** A write root as a message prints it: `docs/`, or a configured documentation directory. */
const ROOT_PATTERN = "(?:[A-Za-z0-9_.-]+/)+";
/** A file root as a message prints it: the one tracked page it grants, such as `README.md`. */
const FILE_ROOT_PATTERN = "(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+";
const PRINTABLE_PATH = new RegExp(`^${PATH_PATTERN}$`, "u");
const PRINTABLE_ROOT = new RegExp(`^${ROOT_PATTERN}$`, "u");
const PRINTABLE_FILE_ROOT = new RegExp(`^${FILE_ROOT_PATTERN}$`, "u");
const CANNOT_WRITE = "DocsFab cannot write ";
/** The rules a refusal names pages under; a `page-path` refusal names none. */
type NamedTargetRule = Exclude<DocumentationWriteTargetRule, "page-path">;
const TARGET_RULE_ORDER: readonly NamedTargetRule[] = [
  "write-roots",
  "configured-roots",
  "protected-path",
];
/**
 * Rule sentences under each root policy. The configured-roots sentence wraps
 * the roots that remain; roots narrowed to none never reach it, because that
 * is the configuration refusal. The tail follows any write-roots sentence, and
 * under local widening any configured-roots sentence too.
 */
const TARGET_RULE_TEXT: Readonly<
  Record<
    DocumentationRootPolicy,
    {
      readonly "write-roots": string;
      readonly "protected-path": string;
      readonly configuredRoots: readonly [string, string];
      readonly tail: string;
    }
  >
> = {
  narrow: {
    "write-roots":
      "a named page must be a Markdown file under docs/ or fern/, the documentation write roots",
    "protected-path": "a named page cannot be in a protected, source, or CI path",
    configuredRoots: [
      "a named page must be ",
      ", the documentationRoots in .docsfab.json inside docs/ or fern/",
    ],
    tail: "Writing pages in other documentation trees is tracked in issue #1603.",
  },
  // Owner amendment to Decision 8, option A (#1914 note 72942914): a local run
  // honors a configured documentation directory anywhere in the repository.
  "local-widen": {
    "write-roots":
      "a named page must be a Markdown file under docs/ or fern/, the default documentation write roots",
    "protected-path":
      "a named page cannot be in a protected, hidden, code, or CI path, or be an agent instruction file such as AGENTS.md",
    configuredRoots: ["a named page must be ", ", the documentationRoots in .docsfab.json"],
    tail: "To write pages in another documentation directory, list it in documentationRoots in .docsfab.json.",
  },
};
const REPEATED_TARGETS_TEXT = [
  "The documentation output list names the same target more than once: ",
  ". DocsFab does not guess which mention of a repeated page sets its scope.",
] as const;

function unadmittedTargetsMessage(
  refused: readonly RefusedDocumentationTarget[],
  roots: readonly string[],
  policy: DocumentationRootPolicy,
): string | undefined {
  if (refused.some((item) => item.rule === "page-path")) return undefined;
  const texts = TARGET_RULE_TEXT[policy];
  const sentences: string[] = [];
  let tail = false;
  for (const rule of TARGET_RULE_ORDER) {
    const paths = sortedUnique(
      refused.filter((item) => item.rule === rule).map((item) => item.path),
    );
    if (paths.length === 0) continue;
    if (!paths.every((path) => PRINTABLE_PATH.test(path))) return undefined;
    let text: string;
    if (rule === "configured-roots") {
      const directories = roots.filter((root) => root.endsWith("/"));
      const files = roots.filter((root) => !root.endsWith("/"));
      if (
        roots.length === 0 ||
        !directories.every((root) => PRINTABLE_ROOT.test(root)) ||
        !files.every((root) => PRINTABLE_FILE_ROOT.test(root))
      ) {
        return undefined;
      }
      const where = [
        ...(directories.length > 0 ? [`under ${listText(directories)}`] : []),
        ...(files.length > 0 ? [orText(files)] : []),
      ].join(", or be ");
      text = `${texts.configuredRoots[0]}${where}${texts.configuredRoots[1]}`;
    } else {
      text = texts[rule];
    }
    sentences.push(`${CANNOT_WRITE}${listText(paths)}: ${text}.`);
    tail ||= rule === "write-roots" || (policy === "local-widen" && rule === "configured-roots");
  }
  if (sentences.length === 0) return undefined;
  return [...sentences, ...(tail ? [texts.tail] : [])].join(" ");
}

function repeatedTargetsMessage(paths: readonly string[]): string | undefined {
  const repeated = sortedUnique(paths);
  if (
    repeated.length === 0 ||
    !repeated.every(
      (path) => PRINTABLE_PATH.test(path) && documentationWriteTargetRule(path) !== "page-path",
    )
  ) {
    return undefined;
  }
  return `${REPEATED_TARGETS_TEXT[0]}${listText(repeated)}${REPEATED_TARGETS_TEXT[1]}`;
}

function printableMessage(message: string | undefined): string | undefined {
  return message !== undefined && credentialFree(message) ? message : undefined;
}

function sortedUnique(items: readonly string[]): string[] {
  return [...new Set(items)].sort(compareText);
}

/** `a`, `a and b`, or `a, b, and c`. */
function listText(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1] ?? ""}`;
}

/** `a`, `a or b`, or `a, b, or c`. */
function orText(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" or ");
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1] ?? ""}`;
}

function escapePattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
}

function listPattern(item: string): string {
  return `${item}(?: and ${item}|(?:, ${item})+, and ${item})?`;
}

function orPattern(item: string): string {
  return `${item}(?: or ${item}|(?:, ${item})+, or ${item})?`;
}

/** Where a configured-roots sentence puts a named page: under directories, or one of the files. */
const CONFIGURED_WHERE_PATTERN = `(?:under ${listPattern(ROOT_PATTERN)}(?:, or be ${orPattern(FILE_ROOT_PATTERN)})?|${orPattern(FILE_ROOT_PATTERN)})`;

const UNADMITTED_TARGET_SENTENCE = `${escapePattern(CANNOT_WRITE)}${listPattern(PATH_PATTERN)}: (?:${Object.values(
  TARGET_RULE_TEXT,
)
  .flatMap((texts) => [
    escapePattern(texts["write-roots"]),
    escapePattern(texts["protected-path"]),
    `${escapePattern(texts.configuredRoots[0])}${CONFIGURED_WHERE_PATTERN}${escapePattern(texts.configuredRoots[1])}`,
  ])
  .join("|")})\\.`;
const UNADMITTED_TARGETS_TAIL = Object.values(TARGET_RULE_TEXT)
  .map((texts) => escapePattern(texts.tail))
  .join("|");
const UNADMITTED_TARGETS_MESSAGE = new RegExp(
  `^${UNADMITTED_TARGET_SENTENCE}(?: ${UNADMITTED_TARGET_SENTENCE})*(?: (?:${UNADMITTED_TARGETS_TAIL}))?$`,
  "u",
);
const REPEATED_TARGETS_MESSAGE = new RegExp(
  `^${escapePattern(REPEATED_TARGETS_TEXT[0])}${listPattern(PATH_PATTERN)}${escapePattern(REPEATED_TARGETS_TEXT[1])}$`,
  "u",
);

/**
 * The proposal-scope code a refusal message carries, for a surface that keeps
 * only the message across a tool boundary. It recognizes a fixed refusal or an
 * exact form that names pages. Any other text, including a decorated variant
 * or text with credential material, is `undefined`.
 */
export function proposalScopeFailureCode(
  message: string,
): FirstRunProposalScopeErrorCode | undefined {
  for (const code of Object.keys(
    FIRST_RUN_PROPOSAL_SCOPE_FAILURES,
  ) as FirstRunProposalScopeErrorCode[]) {
    if (FIRST_RUN_PROPOSAL_SCOPE_FAILURES[code] === message) return code;
  }
  if (!credentialFree(message)) return undefined;
  if (UNADMITTED_TARGETS_MESSAGE.test(message)) return "proposal-scope-unsafe-target";
  if (REPEATED_TARGETS_MESSAGE.test(message)) return "proposal-scope-duplicate-targets";
  return undefined;
}

const NON_INTERACTIVE_PROMPT: DocsFabInitPrompt = {
  async chooseRemote(): Promise<string> {
    throw new Error("First-run project configuration cannot prompt for a remote.");
  },
  async confirm(): Promise<boolean> {
    return false;
  },
};

export async function planHostDerivedProjectConfig(input: {
  readonly repositoryPath: string;
  readonly commands?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly remote?: string;
}): Promise<HostDerivedProjectConfig> {
  const commands = input.commands ?? new ExecInitCommandRunner();
  const environment = input.environment ?? process.env;
  const repository = await discoverRepository(input.repositoryPath, commands);
  const selected = await selectCanonicalRemote(
    repository,
    input.remote,
    false,
    NON_INTERACTIVE_PROMPT,
  );
  const gitlab = await inspectGitLab(repository.path, selected, commands, environment);
  const projectConfig: DocsFabProjectConfigV1 = {
    schemaVersion: 1,
    gitlab: { remote: selected.name, defaultBranch: gitlab.defaultBranch },
    provider: { configuration: "host" },
    storage: { scope: "user-private" },
  };
  assertDocsFabProjectConfig(projectConfig);
  const repositoryIdentity = await captureRepositoryApprovalIdentity(
    repository.path,
    selected,
    gitlab.defaultBranch,
    commands,
  );
  const derived: HostDerivedProjectConfig = {
    projectConfig,
    repositoryBindingSha256: repositoryIdentity.sha256,
  };
  assertCredentialFree(
    derived,
    "Host-derived project configuration contained credential material and was withheld.",
  );
  return Object.freeze(derived);
}

export async function writeProvisionalProjectConfig(
  workspacePath: string,
  config: DocsFabProjectConfigV1,
): Promise<void> {
  const bytes = projectConfigBytes(config);
  const path = join(workspacePath, DOCSFAB_PROJECT_CONFIG_FILE);
  const nofollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | nofollow,
      0o644,
    );
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(
        "Workspace already contains a DocsFab project configuration; refusing to mint a provisional file.",
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function bootstrapMissingProjectConfigIntoWorkspace(input: {
  readonly sourcePath: string;
  readonly workspacePath: string;
  readonly allowWrite: boolean;
  readonly writeCapable: boolean;
  readonly commands?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly remote?: string;
  readonly proposalScope?: FirstRunProposalScopeBinding;
  readonly proposalScopeExpected?: {
    readonly workflow: "create-documentation" | "update-documentation";
    readonly instructionSha256: string;
    readonly repositoryRevision: string;
  };
  readonly requireExportedProjectConfig?: boolean;
  /** Host-selected local write only; independent callers retain setup by default. */
  readonly allowLocalUnconfigured?: boolean;
}): Promise<FirstRunProjectConfigResult> {
  if ((input.proposalScope === undefined) !== (input.proposalScopeExpected === undefined)) {
    rejectFirstRunProposalScope("proposal-scope-binding-mismatch");
  }
  const proposalScope =
    input.proposalScope && input.proposalScopeExpected
      ? assertFirstRunProposalScopeBinding(input.proposalScope, input.proposalScopeExpected)
      : undefined;
  const authority: ProjectConfigAuthority = await resolveProjectConfigAuthority(input.sourcePath);
  if (authority.status === "tracked") {
    return { status: "tracked", config: authority.config };
  }
  const mutating = input.allowWrite && input.writeCapable;
  if (!mutating) return { status: "skipped" };
  if (
    input.allowLocalUnconfigured &&
    !input.requireExportedProjectConfig &&
    !proposalScope?.targetPaths.includes(DOCSFAB_PROJECT_CONFIG_FILE)
  ) {
    return { status: "local-unconfigured" };
  }
  const derived = await planHostDerivedProjectConfig({
    repositoryPath: input.sourcePath,
    ...(input.commands ? { commands: input.commands } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.remote ? { remote: input.remote } : {}),
  });
  if (proposalScope && !proposalScope.targetPaths.includes(DOCSFAB_PROJECT_CONFIG_FILE)) {
    if (input.requireExportedProjectConfig) {
      rejectFirstRunProposalScope("proposal-scope-excludes-project-config");
    }
    return { status: "host-private", ...derived };
  }
  await writeProvisionalProjectConfig(input.workspacePath, derived.projectConfig);
  return { status: "bootstrapped", ...derived };
}
