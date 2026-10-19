// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  HarnessStepInput,
  HarnessStepResult,
  HostOperationExecutor,
} from "../execution/contracts.js";
import { repositoryWorkspaceExportLimits } from "../config/repository-discovery-limits.js";
import type { StepRunRecord } from "../records/contracts.js";
import { buildRepositoryDiscoveryInventory } from "../repository/inventory.js";
import {
  readTrackedRepositoryFile,
  verifyTrackedRepositoryEntries,
} from "../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { formatLimitExceeded, formatLimitObservation, limit } from "../config/limits.js";
import {
  CHECK_COMMAND_TIMEOUT_LIMIT,
  CHECK_CREDENTIAL_SCAN_LIMIT,
  CHECK_ISOLATION_UNAVAILABLE,
  CheckSandboxPreparationError,
  prepareCheckSandbox,
  type CheckCommandResult,
} from "./check-sandbox.js";
import {
  CheckIsolationUnavailableError,
  checkIsolationRefusalMessage,
  requiredCheckIsolationRemedy,
  selectRequiredCheckBackend,
} from "./check-isolation-selection.js";
import {
  isRequiredCheckNotRunCause,
  type RequiredCheckLimitationV1,
  type RequiredCheckNotRunCause,
} from "./required-check-limitation.js";
import { compareText } from "../shared/primitives.js";
import {
  auditTemplateConformance,
  type TemplateAuditInputPage,
  type TemplateAuditReportV1,
} from "../templates/audit.js";
import { resolveTemplateSet, type TemplateSetCapability } from "../templates/load.js";
import { readWorkspacePage } from "../templates/page-guidance.js";
import { documentationPlanPagePaths } from "./plan-binding.js";
import {
  DockerCheckContainmentError,
  DockerCheckPreparationError,
  prepareDarwinCheckAuthority,
} from "../validation/host-containment.js";
import {
  scriptFirstCommand,
  shellSimpleCommands,
  soleSimpleCommand,
} from "./workflow-checks/shell-syntax.js";
import {
  DEFAULT_MAKEFILES,
  makeDryRunSoleCommand,
  makefileDryRunBlocker,
} from "./workflow-checks/make-syntax.js";
export { scriptFirstCommand, shellSimpleCommands, soleSimpleCommand };
export { makeDryRunSoleCommand, makefileDryRunBlocker };

interface NativeCheck {
  command: string;
  packagePath: string;
  manager: "npm" | "pnpm" | "yarn" | "make";
  name: string;
}

type WorkflowChecksStepId = "lint-documentation" | "lint-revised-documentation";

/** Program names a repository instruction may require; never a shell. */
export type RequiredCheckProgram =
  | "python3"
  | "python"
  | "npm"
  | "pnpm"
  | "yarn"
  | "make"
  | "pre-commit";

/** Production uses the read-only, offline sandbox; tests may substitute this port. */
export interface CheckCommandAuthority {
  readonly backendIdentity?: "linux-bubblewrap" | "darwin-docker-desktop";
  readonly presentedViewSha256?: string;
  readonly credentialExclusionCount?: number;
  resolve(program: RequiredCheckProgram): Promise<string | undefined>;
  /**
   * Pre-flight inside the sandbox, before a check runs (#1918): the first
   * candidate path that is an executable regular file there, or `undefined`.
   * Without it, DocsFab skips the package-script pre-flight.
   */
  resolveExecutable?(candidates: readonly string[]): Promise<string | undefined>;
  /** The `PATH` directories a check's processes search inside the sandbox. */
  readonly searchPath?: readonly string[];
  run(
    executable: string,
    argv: readonly string[],
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<CheckCommandResult>;
  cleanup(): Promise<void>;
}

export interface WorkflowChecksOptions {
  /** Rejects when read-only, offline isolation cannot be established. */
  prepareAuthority?: (repository: string) => Promise<CheckCommandAuthority>;
  /**
   * The verified template set. When present, the step also audits each page
   * its plan mutates against its governed template, as advisory evidence.
   */
  templates?: TemplateSetCapability;
}

export interface RepositoryInstructionV1 {
  readonly path: string;
  readonly text: string;
}

/** A check a repository instruction requires before a change is proposed. */
export interface RequiredRepositoryCheckV1 {
  /** Exact inline-code command text from the instruction. */
  readonly command: string;
  /** Repository-relative directory of the instruction file; the working directory. */
  readonly directory: string;
  readonly instruction: string;
  /** Present when the command has a supported isolated form. */
  readonly argv?: readonly string[];
  /** Why the command cannot run under isolated command authority. */
  readonly unsupported?: string;
  /**
   * The cause an unsupported command records, parsed from the command alone:
   * `network-unavailable` for a command that needs the network, otherwise
   * `unsupported-check-form`.
   */
  readonly unsupportedCause?: "unsupported-check-form" | "network-unavailable";
  /** A pre-commit hook can request writes; the checked repository remains read-only. */
  readonly sideEffects?: "may-write";
}

export type ClassifiedRepositoryCheckGuidanceV1 =
  | (RequiredRepositoryCheckV1 & { readonly classification: "validation-check" })
  | {
      readonly command: string;
      readonly directory: string;
      readonly instruction: string;
      readonly classification: "contribution-mutation";
      readonly reason: string;
    };

const INSTRUCTION_FILE = /^(?:AGENTS|CLAUDE|GEMINI|COPILOT-INSTRUCTIONS)\.md$/iu;
const SNAPSHOT_KIND = "docsfab-checked-snapshot-v1";
const UNSUPPORTED_FORM =
  "Unsupported check form. The required command is outside the supported isolated check forms: `python3 -m unittest|pytest`, `npm|pnpm|yarn run <script>` or `test`, `make <target>`, and `pre-commit run --all-files`. No shell runs repository instruction text.";
/**
 * The declared cap on discovered native checks one lint step runs (#1932).
 * Repository-required checks are never capped.
 */
export const CHECK_NATIVE_COMMAND_LIMIT = "checks.nativeCommandMax";
/** The largest repository file the host reads to derive or pre-flight a check. */
const TRACKED_FILE_READ_CEILING = 1024 * 1024;
/** Prints `found` or `missing` for one top-level module; it imports nothing. */
const PYTHON_MODULE_PROBE =
  "import importlib.util,sys;sys.stdout.write('found' if importlib.util.find_spec(sys.argv[1]) else 'missing')";

/** Raised when the tested tree cannot be observed within the materialization bounds. */
export class CheckedSnapshotError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CheckedSnapshotError";
  }
}

/**
 * Observes the exact tree a check sees. The digest covers every entry except
 * `.git`, so a later change to any file invalidates earlier check evidence.
 * With `digest: false` only instruction files are read.
 */
export async function observeCheckedSnapshot(
  root: string,
  options: { digest?: boolean } = {},
): Promise<{ sha256: string | null; instructions: readonly RepositoryInstructionV1[] }> {
  const digest = options.digest ?? true;
  // The export's own ceilings, host overrides included, so a raised export
  // ceiling also admits the tree a check sees.
  const exportLimits = repositoryWorkspaceExportLimits();
  const maxTreeEntries = exportLimits.maxTreeEntries.value;
  const maxAggregateBytes = exportLimits.maxAggregateBytes.value;
  const hash = createHash("sha256").update(`${SNAPSHOT_KIND}\n`);
  const instructions: RepositoryInstructionV1[] = [];
  const pending = [""];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const names = (await readdir(join(root, directory), { withFileTypes: true }))
      .map((entry) => entry.name)
      .filter((name) => name !== ".git")
      .sort(compareText);
    for (const name of names) {
      const path = directory ? `${directory}/${name}` : name;
      if (++entries > maxTreeEntries) {
        throw new CheckedSnapshotError(
          `The checked tree exceeds the repository workspace entry bound (maxTreeEntries ${maxTreeEntries}).`,
        );
      }
      const absolute = join(root, path);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        hash.update(`d\0${path}\n`);
        pending.push(path);
      } else if (metadata.isFile()) {
        const instruction = INSTRUCTION_FILE.test(name);
        if (!digest && !instruction) continue;
        bytes += metadata.size;
        if (bytes > maxAggregateBytes) {
          throw new CheckedSnapshotError(
            `The checked tree exceeds the repository workspace byte bound (maxAggregateBytes ${maxAggregateBytes}).`,
          );
        }
        const content = await readRegularFile(absolute);
        const executable = (metadata.mode & fsConstants.S_IXUSR) !== 0 ? "x" : "-";
        hash.update(
          `f\0${path}\0${executable}\0${createHash("sha256").update(content).digest("hex")}\n`,
        );
        if (instruction) instructions.push({ path, text: content.toString("utf8") });
      } else if (metadata.isSymbolicLink()) {
        hash.update(`l\0${path}\0${await readlink(absolute)}\n`);
      } else {
        hash.update(`o\0${path}\n`);
      }
    }
  }
  return {
    sha256: digest ? hash.digest("hex") : null,
    instructions: instructions.sort((left, right) => compareText(left.path, right.path)),
  };
}

async function readRegularFile(path: string): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Derives the checks repository instructions require before a change is
 * proposed. Instructions apply from the repository root and from directories
 * that contain a scoped path.
 */
export function requiredRepositoryChecks(
  instructions: readonly RepositoryInstructionV1[],
  scopePaths: readonly string[] = [],
): readonly RequiredRepositoryCheckV1[] {
  return classifyRepositoryCheckGuidance(instructions, scopePaths)
    .filter((entry) => entry.classification === "validation-check")
    .map(({ classification: _classification, ...check }) => check);
}

/** Classifies source-backed instructions before any command is admitted to execution. */
export function classifyRepositoryCheckGuidance(
  instructions: readonly RepositoryInstructionV1[],
  scopePaths: readonly string[] = [],
): readonly ClassifiedRepositoryCheckGuidanceV1[] {
  const checks = new Map<string, ClassifiedRepositoryCheckGuidanceV1>();
  for (const instruction of instructions) {
    const directory = dirname(instruction.path);
    if (
      directory !== "." &&
      scopePaths.length > 0 &&
      !scopePaths.some((path) => path.startsWith(`${directory}/`))
    )
      continue;
    for (const command of requiredCommandSpans(instruction.text)) {
      const key = `${directory}\0${command}`;
      if (checks.has(key)) continue;
      if (
        /^git +(add|commit|push|tag|merge|rebase|reset|checkout|switch)(?: +|$)/u.test(command) ||
        /^pre-commit +(install|uninstall|autoupdate)(?: +|$)/u.test(command)
      ) {
        checks.set(key, {
          command,
          directory,
          instruction: instruction.path,
          classification: "contribution-mutation",
          reason:
            "Contribution mutation; this is not a validation check and DocsFab did not run it.",
        });
        continue;
      }
      const argv = parseRequiredCommand(command);
      const network = argv ? undefined : networkCommand(command.split(/ +/u).filter(Boolean));
      checks.set(key, {
        command,
        directory,
        instruction: instruction.path,
        classification: "validation-check",
        ...(argv?.[0] === "pre-commit" ? { sideEffects: "may-write" as const } : {}),
        ...(argv
          ? { argv }
          : network
            ? { unsupported: networkReason(network), unsupportedCause: "network-unavailable" }
            : { unsupported: UNSUPPORTED_FORM, unsupportedCause: "unsupported-check-form" }),
      });
    }
  }
  return [...checks.values()].sort(
    (left, right) =>
      compareText(left.directory, right.directory) || compareText(left.command, right.command),
  );
}

function requiredCommandSpans(text: string): string[] {
  const spans: string[] = [];
  const masked = text.replace(/`([^`\n]+)`/gu, (_match, code: string) => {
    spans.push(code.trim());
    return `\u0000${spans.length - 1}\u0000`;
  });
  const commands: string[] = [];
  for (const sentence of masked.split(/(?<=[.!?])\s+|\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)/u)) {
    if (
      !/\b(?:run|execute)\b/iu.test(sentence) ||
      !/\bbefore\b[^\n]*?\b(?:propos|submit|commit|push|open|merg|send|publish)/iu.test(sentence) ||
      /\b(?:do not|don.t|never|avoid|must not)\b/iu.test(sentence)
    )
      continue;
    for (const match of sentence.matchAll(/\u0000(\d+)\u0000/gu)) {
      const span = spans[Number(match[1])];
      if (span) commands.push(span);
    }
  }
  return commands;
}

function parseRequiredCommand(command: string): readonly string[] | undefined {
  if (!/^[A-Za-z0-9_@%+=:,./ -]+$/u.test(command)) return undefined;
  const argv = command.split(/ +/u).filter(Boolean);
  if (
    argv.some(
      (token) => token.startsWith("/") || token.split(/[/=]/u).some((part) => part === ".."),
    )
  )
    return undefined;
  const [program, first, second] = argv;
  if (
    (program === "python3" || program === "python") &&
    first === "-m" &&
    (second === "unittest" || second === "pytest")
  )
    return argv;
  if (
    (program === "npm" || program === "pnpm" || program === "yarn") &&
    ((first === "run" && second !== undefined && !second.startsWith("-")) || first === "test")
  )
    return argv;
  if (program === "make") return argv;
  if (argv.length === 3 && program === "pre-commit" && first === "run" && second === "--all-files")
    return argv;
  return undefined;
}

/** A single dry-run recipe that enters a child package and runs its named script. */
function nestedOfflineNpmPackage(
  output: string,
  goal: string,
): { directory: string; script: string } | undefined {
  const lines = output.trimEnd().split("\n");
  if (lines.length !== 2) return undefined;
  const trace =
    /^(?:GNUmakefile|makefile|Makefile):\d+: (?:target '(.+)' does not exist|update target '(.+)' due to: .*)$/u.exec(
      lines[0]!,
    );
  if (!trace || (trace[1] ?? trace[2]) !== goal) return undefined;
  const match = /^cd ([a-zA-Z0-9][a-zA-Z0-9._/-]*) && npm run ([a-zA-Z0-9][a-zA-Z0-9:._-]*)$/u.exec(
    lines[1]!,
  );
  if (!match || match[1]!.split("/").some((part) => part === "..")) return undefined;
  return { directory: match[1]!, script: match[2]! };
}

/**
 * The display name of a command that needs the network, parsed from its words
 * alone (#1918): a link checker that checks external links, Sphinx's
 * `linkcheck` builder, `mkdocs gh-deploy`, or an installer that fetches
 * packages. `undefined` for anything
 * else. The sandbox stays offline, so such a check could not run there.
 */
export function networkCommand(words: readonly string[]): string | undefined {
  const [tool, first, second, third] = words;
  if (!tool) return undefined;
  const name = tool.slice(tool.lastIndexOf("/") + 1);
  if (name === "lychee") return words.includes("--offline") ? undefined : name;
  if (name === "markdown-link-check") return name;
  // LinkChecker leaves external links alone unless asked, or given a URL.
  if (name === "linkchecker") {
    return words.includes("--check-extern") || words.some((word) => /^https?:\/\//iu.test(word))
      ? name
      : undefined;
  }
  if (name === "mkdocs" && first === "gh-deploy") return "mkdocs gh-deploy";
  // Sphinx's linkcheck builder checks every external link.
  const builder = words.findIndex((word) => word === "-b" || word === "-M");
  if (name === "sphinx-build" && builder > 0 && words[builder + 1] === "linkcheck") {
    return "sphinx-build linkcheck";
  }
  if ((name === "pip" || name === "pip3") && first === "install") return `${name} install`;
  if ((name === "python" || name === "python3") && first === "-m" && second === "pip") {
    return third === "install" ? `${name} -m pip install` : undefined;
  }
  if (name === "npm" && (first === "ci" || first === "install" || first === "i")) {
    return `npm ${first}`;
  }
  if (name === "pnpm" && (first === "install" || first === "i")) return `pnpm ${first}`;
  if (name === "yarn" && (first === undefined || first === "install")) return "yarn install";
  if (name === "uv" && (first === "sync" || (first === "pip" && second === "install"))) {
    return first === "sync" ? "uv sync" : "uv pip install";
  }
  return undefined;
}

function networkReason(command: string): string {
  return `The check runs \`${command}\`, which needs the network, and the check sandbox is offline.`;
}

/**
 * Fixed repository-owned check entry points, never shell text from the prompt.
 * Repository-required checks come only from host-read instruction files.
 */
export class WorkflowChecksHostOperation implements HostOperationExecutor {
  private readonly prepareAuthority: (repository: string) => Promise<CheckCommandAuthority>;
  private readonly templates: TemplateSetCapability | undefined;

  public constructor(
    private readonly workspace: RepositoryWorkspace,
    private readonly stepId: WorkflowChecksStepId = "lint-documentation",
    options: WorkflowChecksOptions = {},
  ) {
    this.prepareAuthority =
      options.prepareAuthority ?? (() => hostSelectedCheckAuthority(this.workspace));
    this.templates = options.templates;
  }

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    const checked = await this.runChecks(input);
    const conformance = await this.templateConformance(input);
    if (!conformance || checked.summary === undefined) return checked;
    // The report is advisory: it is added beside the check results and never
    // changes the step's status.
    const summary = JSON.parse(checked.summary) as Record<string, unknown>;
    return {
      ...checked,
      summary: JSON.stringify({ ...summary, templateConformance: conformance }),
    };
  }

  /**
   * The existing template audit of each admitted authoring or focused review
   * page. A page absent from the working tree holds no auditable content; the
   * review result reports its mapping and applicability as unknown.
   */
  private async templateConformance(
    input: HarnessStepInput,
  ): Promise<TemplateAuditReportV1 | undefined> {
    if (!this.templates) return undefined;
    const paths = input.planBinding
      ? documentationPlanPagePaths(input.planBinding)
      : input.workflow.name === "review-documentation"
        ? (input.reviewScope?.targetPaths ?? [])
        : [];
    if (paths.length === 0) return undefined;
    const bundle = resolveTemplateSet(this.templates);
    const pages: TemplateAuditInputPage[] = [];
    for (const path of paths) {
      input.signal?.throwIfAborted();
      const page = await readWorkspacePage(this.workspace.path, path);
      if (page) pages.push(page);
    }
    if (pages.length === 0) return undefined;
    return auditTemplateConformance({
      bundle,
      pages,
      scope: { kind: "focused-set", enumeration: "complete", omittedEntries: 0, limitations: [] },
    });
  }

  private async runChecks(input: HarnessStepInput): Promise<HarnessStepResult> {
    if (
      input.step.id !== this.stepId ||
      resolve(input.repositoryPath) !== resolve(this.workspace.path)
    ) {
      throw new Error("Host documentation checks require the bound repository and lint step.");
    }
    const inventory = await buildRepositoryDiscoveryInventory({ workspace: this.workspace });
    const targets = input.reviewScope?.targetPaths ?? [];
    const checks: NativeCheck[] = inventory.commands.flatMap((command) => {
      const match = /^(npm|pnpm|yarn) run ([A-Za-z0-9][A-Za-z0-9:._-]*)$/u.exec(command.invocation);
      if (!match || !["lint", "link-check"].includes(command.purpose)) return [];
      const name = match[2]!;
      const directory = dirname(command.packagePath);
      const relevant =
        targets.length === 0 ||
        directory === "." ||
        targets.some((path) => path.startsWith(`${directory}/`));
      const docsSpecific =
        /(?:^|[:-])(?:docs?|documentation|markdown|mdx|links?|linkcheck|fern)(?:[:-]|$)/u.test(
          name,
        );
      const docsPackage = /(?:^|\/)(?:docs?|documentation|website|site)(?:\/|$)/u.test(directory);
      if (!relevant || !(docsSpecific || (docsPackage && /^(?:lint|check)$/u.test(name))))
        return [];
      return [
        {
          command: command.invocation,
          packagePath: command.packagePath,
          manager: match[1] as NativeCheck["manager"],
          name,
        },
      ];
    });
    for (const file of inventory.files.filter((entry) => /(?:^|\/)Makefile$/u.test(entry.path))) {
      const directory = dirname(file.path);
      if (
        targets.length &&
        directory !== "." &&
        !targets.some((path) => path.startsWith(`${directory}/`))
      )
        continue;
      const source = (
        await readTrackedRepositoryFile(this.workspace, file.path, TRACKED_FILE_READ_CEILING)
      ).toString("utf8");
      for (const match of source.matchAll(
        /^(fern-check|docs?-(?:check|lint|validate)|(?:check|lint|validate)-docs?):[ \t]*(?:[^=\n]*)$/gmu,
      )) {
        checks.push({
          command: `make ${match[1]!}`,
          packagePath: file.path,
          manager: "make",
          name: match[1]!,
        });
      }
    }

    // Repository-required checks are derived by the host from the exact tested
    // tree, never from model text, and bound to that tree snapshot digest.
    let snapshotSha256: string;
    let required: readonly RequiredRepositoryCheckV1[];
    let contribution: readonly Extract<
      ClassifiedRepositoryCheckGuidanceV1,
      { classification: "contribution-mutation" }
    >[];
    try {
      const snapshot = await observeCheckedSnapshot(this.workspace.path);
      snapshotSha256 = snapshot.sha256!;
      const guidance = classifyRepositoryCheckGuidance(
        snapshot.instructions,
        input.planBinding?.pages.map((page) => page.path) ?? targets,
      );
      required = guidance
        .filter((entry) => entry.classification === "validation-check")
        .map(({ classification: _classification, ...check }) => check);
      contribution = guidance.filter((entry) => entry.classification === "contribution-mutation");
      const altered = await alteredInstructionPaths(this.workspace, snapshot.instructions);
      if (altered.length > 0) {
        return result(
          [
            {
              status: "unavailable",
              required: true,
              reason: `Repository instructions differ from the admitted revision (${altered.join(", ")}); required checks cannot be derived from a candidate-modified instruction.`,
            },
          ],
          { snapshotSha256, required },
        );
      }
    } catch (error) {
      return result([
        {
          status: "unavailable",
          required: true,
          reason:
            error instanceof CheckedSnapshotError
              ? error.message
              : "The tested repository snapshot could not be observed.",
        },
      ]);
    }
    const binding = { snapshotSha256, required };

    const evidence: Array<Record<string, unknown>> = contribution.map((entry) => ({
      command: entry.command,
      directory: entry.directory,
      instruction: entry.instruction,
      classification: entry.classification,
      status: "not-run",
      reason: entry.reason,
    }));

    if (!checks.length && !required.length)
      return result(
        [
          ...evidence,
          {
            status: "unavailable",
            reason:
              "No supported native documentation checks were found. Supported entry points are documentation lint/check/link package scripts and documentation check Make targets.",
          },
        ],
        binding,
      );
    evidence.push(
      ...required
        .filter((check) => check.unsupported)
        .map((check) =>
          requiredEvidence(
            check,
            "unavailable",
            check.unsupported,
            check.unsupportedCause ?? "unsupported-check-form",
          ),
        ),
    );
    // A discovered native check that repeats a required one in the same
    // directory runs once, as the required check.
    const requiredKeys = new Set(required.map((check) => `${check.directory}\0${check.command}`));
    const runnable = [
      ...required
        .filter((check) => !check.unsupported)
        .map((check) => ({ kind: "required" as const, check })),
      ...checks
        .filter((check) => !requiredKeys.has(`${dirname(check.packagePath)}\0${check.command}`))
        .map((check) => ({ kind: "native" as const, check })),
    ];
    // Nothing can run: no sandbox, no Git metadata, and no second look at the tree.
    if (runnable.length === 0) return result(evidence, binding);
    let authority: CheckCommandAuthority;
    try {
      authority = await this.prepareAuthority(this.workspace.path);
    } catch (error) {
      // Failed container teardown is a defect, never a not-run limitation.
      if (error instanceof DockerCheckContainmentError) throw error;
      // A sandbox that could not be configured faithfully runs nothing: each
      // required check records the structural cause (#1918, #1932).
      if (error instanceof CheckSandboxLimitationError) {
        for (const entry of runnable) {
          if (entry.kind === "required")
            evidence.push(requiredEvidence(entry.check, "unavailable", error.message, error.cause));
        }
        if (checks.length) evidence.push({ status: "unavailable", reason: error.message });
        return result(evidence, binding);
      }
      // Only a typed isolation refusal carries its reason into evidence. Any
      // other error (a defect, or a message that may name host paths) records
      // the generic reason, never its own message.
      const isolation =
        error instanceof CheckIsolationUnavailableError
          ? { reason: error.message, isolationRefusal: error.refusal }
          : { reason: CHECK_ISOLATION_UNAVAILABLE };
      for (const entry of runnable) {
        if (entry.kind === "required")
          evidence.push({
            ...requiredEvidence(
              entry.check,
              "unavailable",
              isolation.reason,
              "isolation-unavailable",
            ),
            ...isolation,
          });
      }
      if (checks.length) evidence.push({ status: "unavailable", ...isolation });
      return result(evidence, binding);
    }
    let cleanupFailure: string | undefined;
    try {
      // Every required check runs (#1932). Discovered native checks follow,
      // up to their declared limit, and any past it stay visible by name.
      const nativeLimit = limit(CHECK_NATIVE_COMMAND_LIMIT);
      const native = runnable.filter((entry) => entry.kind === "native");
      const batch = [
        ...runnable.filter((entry) => entry.kind === "required"),
        ...native.slice(0, nativeLimit.value),
      ];
      for (const entry of batch) {
        evidence.push({
          ...(entry.kind === "required"
            ? await this.runRequired(entry.check, authority, input.signal)
            : await this.runNative(entry.check, authority, input.signal)),
          ...(authority.backendIdentity ? { backendIdentity: authority.backendIdentity } : {}),
          ...(authority.presentedViewSha256
            ? { presentedViewSha256: authority.presentedViewSha256 }
            : {}),
          ...(authority.credentialExclusionCount !== undefined
            ? {
                credentialExclusionPolicy: "credential-name-v1",
                credentialExclusionCount: authority.credentialExclusionCount,
              }
            : {}),
        });
        if (input.signal?.aborted) break;
      }
      if (native.length > nativeLimit.value)
        evidence.push({
          status: "unavailable",
          reason: formatLimitObservation(nativeLimit, native.length),
        });
    } finally {
      // A cleanup failure never fails the run (#1918): the evidence records its
      // code, and the run removes its workspace copy with the rest.
      cleanupFailure = await authority.cleanup().then(
        () => undefined,
        (error: unknown) => cleanupErrorCode(error),
      );
    }
    let after: string | null = null;
    try {
      after = (await observeCheckedSnapshot(this.workspace.path)).sha256;
    } catch {
      /* An unobservable tree is treated as changed below. */
    }
    if (after !== snapshotSha256) {
      return result(
        evidence.map((entry) =>
          entry.required === true
            ? {
                ...entry,
                status: "unavailable",
                reason: "The tested tree changed while checks ran.",
                cause: "tree-changed",
              }
            : entry,
        ),
        binding,
        cleanupFailure,
      );
    }
    return result(evidence, binding, cleanupFailure);
  }

  private async runRequired(
    check: RequiredRepositoryCheckV1,
    authority: CheckCommandAuthority,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const cwd = resolve(this.workspace.path, check.directory);
    if (relative(this.workspace.path, cwd).startsWith(".."))
      throw new Error("The required check working directory escaped the bound repository.");
    const [program, ...argv] = check.argv!;
    const executable = await authority.resolve(program as RequiredCheckProgram);
    if (!executable)
      return requiredEvidence(
        check,
        "unavailable",
        `The ${program} executable is not available to the isolated check executor.`,
        "dependency-unavailable",
      );
    const notRun = await this.preflight(check, cwd, executable, authority, signal);
    if (notRun) return requiredEvidence(check, "unavailable", notRun.reason, notRun.cause);
    const commandResult = await authority.run(executable, argv, { cwd, signal });
    return {
      ...requiredEvidence(check, commandResult.status),
      ...commandResult,
      ...notRunEvidence(commandResult),
    };
  }

  /**
   * The structural pre-flight of a supported required check, before it runs
   * (#1918). It reads the command, the repository's own package manifest and
   * makefile, and make's dry-run listing, never the output of the check itself:
   *
   * - `npm|pnpm|yarn run <script>` or `test`: when the script's first
   *   command's failure would end the script (`scriptFirstCommand`), its
   *   program must resolve inside the sandbox, in a `node_modules/.bin` from
   *   the check directory up to the root or on the sandbox `PATH`
   *   (`dependency-unavailable`), and must not be a command that needs the
   *   network (`network-unavailable`);
   * - `python3|python -m <module>`: the module must be importable by the
   *   sandbox's Python (`dependency-unavailable`);
   * - `make <target>`: see `makePreflight`.
   *
   * Anything it cannot read without a shell runs as usual, so a check that
   * fails is refused.
   */
  private async preflight(
    check: RequiredRepositoryCheckV1,
    cwd: string,
    executable: string,
    authority: CheckCommandAuthority,
    signal: AbortSignal | undefined,
  ): Promise<{ cause: RequiredCheckNotRunCause; reason: string } | undefined> {
    const [program, first, second] = check.argv!;
    if (program === "make") return this.makePreflight(check, cwd, executable, authority, signal);
    if (program === "python3" || program === "python") {
      const module = (second ?? "").split(".")[0]!;
      if (module === "unittest" || !module) return undefined;
      const probe = await authority.run(executable, ["-c", PYTHON_MODULE_PROBE, module], {
        cwd,
        signal,
      });
      return probe.status === "passed" && probe.output === "missing"
        ? {
            cause: "dependency-unavailable",
            reason: `The \`${module}\` module that \`${check.command}\` runs is not installed for the check sandbox's Python.`,
          }
        : undefined;
    }
    if (program !== "npm" && program !== "pnpm" && program !== "yarn") return undefined;
    const script = first === "test" ? "test" : second;
    if (!script || !authority.resolveExecutable) return undefined;
    const manifestPath =
      check.directory === "." ? "package.json" : `${check.directory}/package.json`;
    let body: unknown;
    try {
      const manifest: unknown = JSON.parse(
        (
          await readTrackedRepositoryFile(this.workspace, manifestPath, TRACKED_FILE_READ_CEILING)
        ).toString("utf8"),
      );
      const scripts =
        manifest && typeof manifest === "object"
          ? (manifest as { scripts?: unknown }).scripts
          : undefined;
      body =
        scripts && typeof scripts === "object"
          ? (scripts as Record<string, unknown>)[script]
          : undefined;
    } catch {
      // A manifest the change edits, or none, is read by the check itself.
      return undefined;
    }
    if (typeof body !== "string") return undefined;
    const command = scriptFirstCommand(body);
    if (!command) return undefined;
    const network = networkCommand(command);
    if (network) return { cause: "network-unavailable", reason: networkReason(network) };
    const name = command[0]!;
    // A script that starts a repository file runs it as usual, and so does a
    // Yarn Plug'n'Play script: Yarn's own loader finds its programs, which have
    // no `node_modules/.bin`.
    if (name.includes("/") || (program === "yarn" && (await this.yarnPlugAndPlay()))) {
      return undefined;
    }
    const candidates = [
      ...this.nodeBinDirectories(check.directory),
      ...(authority.searchPath ?? []),
    ].map((directory) => join(directory, name));
    return (await authority.resolveExecutable(candidates))
      ? undefined
      : {
          cause: "dependency-unavailable",
          reason: `The \`${name}\` program that \`${check.command}\` starts is not installed in the check sandbox: no \`node_modules/.bin\` or \`PATH\` entry has it.`,
        };
  }

  /** `node_modules/.bin` in a repository directory and each directory above it. */
  private nodeBinDirectories(directory: string): string[] {
    const directories: string[] = [];
    for (let current = directory; ; current = dirname(current)) {
      directories.push(resolve(this.workspace.path, current, "node_modules", ".bin"));
      if (current === "." || current === "/" || current === dirname(current)) break;
    }
    return directories;
  }

  /**
   * The pre-flight of a required `make <target>` check (#1918), for the sound
   * subset only: the target's makefile is tracked, unchanged, and holds none
   * of the constructs `makefileDryRunBlocker` names, and GNU make's dry run,
   * inside the sandbox, lists exactly one recipe line for the target, which is
   * one simple command. Then the command that line starts is the one the check
   * runs first and last: a command that needs the network is
   * `network-unavailable`, and a program that no sandbox `PATH` entry has, or
   * a program path the checked copy lacks, is `dependency-unavailable`. Any
   * other target runs as usual, so a check that fails is still refused.
   */
  private async makePreflight(
    check: RequiredRepositoryCheckV1,
    cwd: string,
    executable: string,
    authority: CheckCommandAuthority,
    signal: AbortSignal | undefined,
  ): Promise<{ cause: RequiredCheckNotRunCause; reason: string } | undefined> {
    const resolveExecutable = authority.resolveExecutable;
    const goals = check.argv!.slice(1);
    const goal = goals[0];
    if (
      !resolveExecutable ||
      goals.length !== 1 ||
      !goal ||
      goal.startsWith("-") ||
      goal.includes("=")
    ) {
      return undefined;
    }
    const makefile = await this.trackedMakefile(check.directory);
    if (makefile === undefined || makefileDryRunBlocker(makefile) !== undefined) return undefined;
    const dryRun = await authority.run(executable, ["--dry-run", "--trace", goal], { cwd, signal });
    if (dryRun.status !== "passed" || dryRun.reason || dryRun.outputOmittedBytes !== undefined) {
      return undefined;
    }
    const nestedNpm =
      goal === "docs-check" ? nestedOfflineNpmPackage(dryRun.output, goal) : undefined;
    if (nestedNpm) {
      const manifestPath =
        check.directory === "."
          ? `${nestedNpm.directory}/package.json`
          : `${check.directory}/${nestedNpm.directory}/package.json`;
      try {
        const manifest = JSON.parse(
          (
            await readTrackedRepositoryFile(this.workspace, manifestPath, TRACKED_FILE_READ_CEILING)
          ).toString("utf8"),
        ) as { scripts?: Record<string, unknown> };
        const script = manifest.scripts?.[nestedNpm.script];
        const packageName =
          typeof script === "string"
            ? /^npx -y ([a-z][a-z0-9-]*@latest) check$/u.exec(script)?.[1]
            : undefined;
        if (packageName) {
          const localPackage = resolve(
            cwd,
            nestedNpm.directory,
            "node_modules",
            packageName.slice(0, -"@latest".length),
          );
          if (
            await lstat(localPackage).then(
              () => true,
              () => false,
            )
          )
            return undefined;
          const npm = await authority.resolve("npm");
          if (!npm) return undefined;
          const cache = await authority.run(npm, ["cache", "ls", packageName], {
            cwd: resolve(cwd, nestedNpm.directory),
            signal,
          });
          if (
            cache.status === "passed" &&
            !cache.reason &&
            cache.outputOmittedBytes === undefined &&
            cache.output.trim() === ""
          )
            return {
              cause: "dependency-unavailable",
              reason: `The offline npm cache lacks \`${packageName}\`, which the tracked \`${manifestPath}\` script needs for \`${check.command}\`; documentation content was not assessed.`,
            };
        }
      } catch {
        // A changed or unreadable package manifest does not establish absence.
      }
    }
    const command = makeDryRunSoleCommand(dryRun.output, goal);
    if (!command) return undefined;
    const network = networkCommand(command.words);
    if (network) return { cause: "network-unavailable", reason: networkReason(network) };
    const program = command.words[0]!;
    let present: boolean;
    if (program.includes("/")) {
      // A path in the checked copy is looked up there; any other, in the sandbox.
      const path = resolve(cwd, program);
      present = relative(this.workspace.path, path).startsWith("..")
        ? Boolean(await resolveExecutable([path]))
        : await lstat(path).then(
            () => true,
            () => false,
          );
    } else {
      const directories = [
        ...(command.npx ? this.nodeBinDirectories(check.directory) : []),
        ...(authority.searchPath ?? []),
      ];
      if (directories.length === 0) return undefined;
      present = Boolean(
        await resolveExecutable(directories.map((directory) => join(directory, program))),
      );
    }
    return present
      ? undefined
      : {
          cause: "dependency-unavailable",
          reason: `The \`${program}\` program that \`${check.command}\` runs, the only command \`make --dry-run\` lists for it, is not installed in the check sandbox.`,
        };
  }

  /**
   * The text of the makefile GNU make reads in a repository directory, when it
   * is tracked and unchanged from the admitted revision; `undefined` otherwise.
   */
  private async trackedMakefile(directory: string): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(resolve(this.workspace.path, directory));
    } catch {
      return undefined;
    }
    const name = DEFAULT_MAKEFILES.find((candidate) => names.includes(candidate));
    if (!name) return undefined;
    try {
      return (
        await readTrackedRepositoryFile(
          this.workspace,
          directory === "." ? name : `${directory}/${name}`,
          TRACKED_FILE_READ_CEILING,
        )
      ).toString("utf8");
    } catch {
      return undefined;
    }
  }

  /** Whether the checked copy is a Yarn Plug'n'Play project, by its loader file. */
  private async yarnPlugAndPlay(): Promise<boolean> {
    for (const loader of [".pnp.cjs", ".pnp.js"]) {
      try {
        await lstat(resolve(this.workspace.path, loader));
        return true;
      } catch {
        /* Not this loader. */
      }
    }
    return false;
  }

  private async runNative(
    check: NativeCheck,
    authority: CheckCommandAuthority,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const cwd = resolve(this.workspace.path, dirname(check.packagePath));
    if (relative(this.workspace.path, cwd).startsWith(".."))
      throw new Error("The documentation check working directory escaped the bound repository.");
    const executable = await authority.resolve(check.manager);
    if (!executable) {
      return {
        command: check.command,
        directory: dirname(check.packagePath),
        source: check.packagePath,
        classification: "validation-check",
        status: "unavailable",
        reason: `The ${check.manager} executable is not installed beside the host runtime.`,
      };
    }
    if (
      check.manager === "make" &&
      check.name === "docs-check" &&
      (await this.trackedMakefile(dirname(check.packagePath)))?.includes("&& npm run")
    ) {
      const preflight = await this.makePreflight(
        {
          command: check.command,
          directory: dirname(check.packagePath),
          instruction: check.packagePath,
          argv: ["make", check.name],
        },
        cwd,
        executable,
        authority,
        signal,
      );
      if (preflight)
        return {
          command: check.command,
          directory: dirname(check.packagePath),
          source: check.packagePath,
          classification: "validation-check",
          status: "unavailable",
          ...preflight,
        };
    }
    const args =
      check.manager === "make" ? ["--no-print-directory", check.name] : ["run", check.name];
    const commandResult = await authority.run(executable, args, { cwd, signal });
    return {
      command: check.command,
      directory: dirname(check.packagePath),
      source: check.packagePath,
      classification: "validation-check",
      ...commandResult,
      ...notRunEvidence(commandResult),
    };
  }
}

/** Trusted host dependencies of the default check authority; never serialized input. */
export interface HostSelectedCheckAuthorityDependencies {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `prepareCheckSandbox`. */
  readonly prepareSandbox?: typeof prepareCheckSandbox;
  /** Host-owned Docker preparation; tests inject an unavailable backend. */
  readonly prepareDocker?: typeof prepareDarwinCheckAuthority;
}

/**
 * The default required-check authority. It selects the backend through the
 * host validation-backend capability before any sandbox is prepared, so a
 * refused selection launches nothing. No error, including one that would allow
 * delivery's operator-supervised fallback, runs a command outside the sandbox.
 */
export async function hostSelectedCheckAuthority(
  repository: RepositoryWorkspace | string,
  dependencies: HostSelectedCheckAuthorityDependencies = {},
): Promise<CheckCommandAuthority> {
  const platform = dependencies.platform ?? process.platform;
  const selection = selectRequiredCheckBackend(platform);
  // A refused selection (macOS, unsupported platforms, untrusted capabilities)
  // prepares and launches nothing.
  if (selection.status !== "selected") throw new CheckIsolationUnavailableError(selection);
  if (selection.identity === "darwin-docker-desktop") {
    try {
      if (typeof repository === "string" && !dependencies.prepareDocker) {
        throw new DockerCheckPreparationError(
          "A host-issued private workspace is required for Docker checks.",
          "view",
        );
      }
      return await (dependencies.prepareDocker ?? prepareDarwinCheckAuthority)(
        repository as RepositoryWorkspace,
        observeCheckedSnapshot,
      );
    } catch (error) {
      if (!(error instanceof DockerCheckPreparationError)) throw error;
      if (error.stage === "scan-bound")
        throw new CheckSandboxLimitationError(error.message, "credential-scan-bound");
      const refusal =
        error.stage === "view"
          ? "darwin-check-preparation-failed"
          : "darwin-docker-desktop-unavailable";
      throw new CheckIsolationUnavailableError({
        status: "refused",
        refusal,
        message: checkIsolationRefusalMessage(refusal, platform),
      });
    }
  }
  let sandbox: Awaited<ReturnType<typeof prepareCheckSandbox>>;
  try {
    sandbox = await (dependencies.prepareSandbox ?? prepareCheckSandbox)(
      typeof repository === "string" ? repository : repository.path,
    );
  } catch (error) {
    // Each typed preparation stage maps to its own refusal; any other error
    // records the generic reason. Errors from running a check after
    // establishment are not caught here.
    if (!(error instanceof CheckSandboxPreparationError))
      throw new Error(CHECK_ISOLATION_UNAVAILABLE);
    // A sandbox that ran into a declared bound, or could not present Git
    // metadata, is a structural limitation, not missing isolation.
    if (error.stage === "credential-scan-bound") {
      throw new CheckSandboxLimitationError(
        formatLimitObservation(limit(CHECK_CREDENTIAL_SCAN_LIMIT), error.observed ?? 0),
        "credential-scan-bound",
      );
    }
    if (error.stage === "git-metadata") {
      throw new CheckSandboxLimitationError(
        "DocsFab could not present Git metadata for the checked copy, so no check ran.",
        "git-metadata-unavailable",
      );
    }
    const refusal =
      error.stage === "bubblewrap-unavailable"
        ? "linux-bubblewrap-unavailable"
        : "linux-check-preparation-failed";
    throw new CheckIsolationUnavailableError({
      status: "refused",
      refusal,
      message: checkIsolationRefusalMessage(refusal, platform),
    });
  }
  // Each program resolves once, inside the sandbox, before any check runs it.
  const resolved = new Map<RequiredCheckProgram, Promise<string | undefined>>();
  return {
    backendIdentity: "linux-bubblewrap",
    resolve: (program) => {
      const candidates =
        program === "make"
          ? ["/usr/bin/make"]
          : program === "pre-commit"
            ? ["/usr/bin/pre-commit", "/usr/local/bin/pre-commit"]
            : program === "python3" || program === "python"
              ? [`/usr/bin/${program}`, `/usr/local/bin/${program}`]
              : [join(sandbox.runtime, "bin", program)];
      let resolution = resolved.get(program);
      if (!resolution) {
        resolution = sandbox.resolveExecutable(candidates);
        resolved.set(program, resolution);
      }
      return resolution;
    },
    resolveExecutable: (candidates) => sandbox.resolveExecutable(candidates),
    searchPath: sandbox.searchPath,
    run: (executable, argv, options) => sandbox.run(executable, argv, options),
    cleanup: sandbox.cleanup,
  };
}

/**
 * A check sandbox that could not be configured faithfully, so no check ran in
 * it: its `cause` is a structural reason a required check could not run, and
 * its message, which names no host path, is that check's recorded reason.
 */
export class CheckSandboxLimitationError extends Error {
  public constructor(
    message: string,
    public readonly cause: RequiredCheckNotRunCause,
  ) {
    super(message);
    this.name = "CheckSandboxLimitationError";
  }
}

async function alteredInstructionPaths(
  workspace: RepositoryWorkspace,
  instructions: readonly RepositoryInstructionV1[],
): Promise<string[]> {
  const verified = new Map(
    (await verifyTrackedRepositoryEntries(workspace)).flatMap((entry) =>
      entry.path && entry.kind === "regular" ? [[entry.path, entry.status] as const] : [],
    ),
  );
  return instructions
    .map((instruction) => instruction.path)
    .filter((path) => verified.get(path) !== "verified");
}

/**
 * Why a launched command did not establish the check, or `undefined` when its
 * result stands. Only the executor's own structural result decides: it could
 * not start the command, it was cancelled, or it stopped the command at the
 * declared time limit (#1932). A command that ran and exited non-zero is
 * `failed`, whatever its exit code or output says (#1918): text a check prints
 * can come from the candidate, so it never makes a failure a limitation.
 */
export function checkNotRunCause(
  commandResult: CheckCommandResult,
): RequiredCheckNotRunCause | undefined {
  if (commandResult.status === "unavailable") {
    return commandResult.reason === "cancelled" ? "cancelled" : "launch-failed";
  }
  if (commandResult.status === "failed" && commandResult.reason === "timeout") return "timeout";
  return undefined;
}

/** The evidence fields that record a launched command as not run, or none. */
function notRunEvidence(commandResult: CheckCommandResult): Record<string, unknown> {
  const cause = checkNotRunCause(commandResult);
  if (cause === undefined) return {};
  if (cause !== "timeout") return { cause };
  return { status: "unavailable", reason: timeoutReason(commandResult), cause };
}

/**
 * The coded line for a command stopped at its time limit: the limit's code,
 * the time the command ran, the limit the executor applied, and how to raise
 * it. Without a recorded run time, the line names the limit alone.
 */
function timeoutReason(commandResult: CheckCommandResult): string {
  const declared = limit(CHECK_COMMAND_TIMEOUT_LIMIT);
  const applied = { ...declared, value: commandResult.timeoutMs ?? declared.value };
  return commandResult.elapsedMs === undefined
    ? formatLimitExceeded(applied)
    : formatLimitObservation(applied, commandResult.elapsedMs);
}

function requiredEvidence(
  check: RequiredRepositoryCheckV1,
  status: CheckCommandResult["status"],
  reason?: string,
  cause?: RequiredCheckNotRunCause,
): Record<string, unknown> {
  return {
    command: check.command,
    directory: check.directory,
    instruction: check.instruction,
    classification: "validation-check",
    ...(check.sideEffects
      ? { sideEffects: check.sideEffects, isolation: "read-only-offline" }
      : {}),
    required: true,
    status,
    ...(reason ? { reason } : {}),
    ...(cause ? { cause } : {}),
  };
}

/** A cleanup error's system code, never its message, which can name host paths. */
function cleanupErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : "unknown";
}

function result(
  checks: Array<Record<string, unknown>>,
  binding?: { snapshotSha256: string; required: readonly RequiredRepositoryCheckV1[] },
  cleanupFailure?: string,
): HarnessStepResult {
  const status = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "unavailable")
      ? "unavailable"
      : "passed";
  return {
    summary: JSON.stringify({
      status,
      coverage:
        "Repository-required checks and selected repository-native documentation checks; commands may cover more than the requested pages. This is check execution evidence, not a quality approval.",
      ...(binding
        ? {
            snapshotSha256: binding.snapshotSha256,
            requiredChecks: binding.required.map((check) => ({
              command: check.command,
              directory: check.directory,
              instruction: check.instruction,
            })),
          }
        : {}),
      checks,
      ...(cleanupFailure ? { sandboxCleanup: { status: "failed", code: cleanupFailure } } : {}),
    }),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, cost: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
  };
}

/**
 * The inner codes a refused proposal records as its run failure code, each
 * classed by its own reason (`RUN_FAILURE_CODE_CLASSES`). A required check that
 * could not run is not among them: it is a recorded limitation (#1918).
 */
export const REQUIRED_CHECK_REFUSAL_CODES = Object.freeze([
  "required-check-failed",
  "required-check-instructions-altered",
  "required-check-evidence-missing",
  "required-check-evidence-stale",
  "required-check-snapshot-unavailable",
] as const);

export type RequiredCheckRefusalCode = (typeof REQUIRED_CHECK_REFUSAL_CODES)[number];

export type RequiredCheckGateResult =
  | { status: "not-required" }
  | { status: "satisfied"; snapshotSha256: string; commands: readonly string[] }
  | {
      /** Every required check passed or could not run; at least one could not run. */
      status: "limited";
      snapshotSha256: string;
      commands: readonly string[];
      limitations: readonly RequiredCheckLimitationV1[];
    }
  | { status: "refused"; code: RequiredCheckRefusalCode; message: string };

/**
 * Admits a write only when every repository-required check passed on the
 * exact tree being proposed, or could not run there. The required set is
 * re-derived from the admitted baseline instructions and the final tree, so
 * evidence that omits, substitutes, or predates a requirement cannot satisfy
 * it. A model statement is never check evidence: only the host lint-operation
 * record is read.
 *
 * A check that could not run (an unsupported command form, no isolation
 * backend, a missing program or dependency, or a sandbox without Git metadata
 * or network), or that ran past its declared time limit, is `limited`: the
 * write stands, and the run records a limitation that names the command for
 * the operator to run. A check that ran and failed refuses with
 * `required-check-failed`. Observation errors refuse with
 * `required-check-snapshot-unavailable`; `not-required` means an observed tree
 * whose baseline/final union has no commands.
 */
export async function assessRequiredRepositoryChecks(input: {
  runId: string;
  workspacePath: string;
  /** Instructions observed before any write; `undefined` when unobservable. */
  baselineInstructions: readonly RepositoryInstructionV1[] | undefined;
  steps: readonly StepRunRecord[];
}): Promise<RequiredCheckGateResult> {
  const lint = [...input.steps]
    .reverse()
    .find(
      (step) =>
        step.kind === "host-operation" &&
        step.skill === "lint-documentation" &&
        step.status === "succeeded",
    );
  const plan = lint?.planBinding ?? input.steps.find((step) => step.planBinding)?.planBinding;
  const scope = plan?.pages.map((page) => page.path) ?? [];
  let final: Awaited<ReturnType<typeof observeCheckedSnapshot>>;
  try {
    final = await observeCheckedSnapshot(input.workspacePath);
  } catch (error) {
    return refused(
      "required-check-snapshot-unavailable",
      `${error instanceof CheckedSnapshotError ? error.message : "The proposed tree could not be observed."} Required repository checks cannot be confirmed for run ${input.runId}, so the patch was not proposed. Next action: reduce the tree below the named bound or run from a readable checkout, then start a new run.`,
    );
  }
  if (input.baselineInstructions === undefined) {
    return refused(
      "required-check-snapshot-unavailable",
      `The admitted repository instructions for run ${input.runId} could not be observed before writing, so required checks cannot be confirmed and the patch was not proposed. Next action: run from a readable checkout, then start a new run.`,
    );
  }
  const required = new Map<string, RequiredRepositoryCheckV1>();
  for (const check of [
    ...requiredRepositoryChecks(input.baselineInstructions, scope),
    ...requiredRepositoryChecks(final.instructions, scope),
  ])
    required.set(`${check.directory}\0${check.command}`, check);
  if (required.size === 0) return { status: "not-required" };
  const inspect = `Inspect \`docsfab runs show ${input.runId}\` for the lint-documentation check evidence and the retained patch.`;
  const evidence = parseCheckEvidence(lint?.summary);
  if (!evidence) {
    return refused(
      "required-check-evidence-missing",
      `Repository instructions require ${describe([...required.values()])} before proposing a change, but run ${input.runId} has no host check evidence for them. The patch was not proposed. ${inspect} This is a runtime defect; do not retry unchanged.`,
    );
  }
  if (evidence.snapshotSha256 !== final.sha256) {
    return refused(
      "required-check-evidence-stale",
      `The required-check evidence for run ${input.runId} was recorded for a different tree than the proposed change, so it cannot establish the checks. The patch was not proposed. ${inspect} This is a runtime defect; do not retry unchanged.`,
    );
  }
  // The lint step records a required entry without a command only when the
  // candidate edited a repository instruction file: it then derives and runs
  // nothing, because a command from a candidate-edited instruction may be model
  // text. Such a command is never offered to the operator as a limitation.
  const altered = evidence.checks.find(
    (entry) =>
      entry.required === true && typeof entry.command !== "string" && entry.status !== "passed",
  );
  if (altered) {
    return refused(
      "required-check-instructions-altered",
      `Required repository checks for run ${input.runId} could not be established (${typeof altered.reason === "string" ? altered.reason : "unavailable"}). DocsFab does not derive check commands from an instruction file the change edits, so the update is not validated and was not proposed. ${inspect} Next action: keep repository instruction files out of this change, or edit them in a separate change, then start a new run.`,
    );
  }
  const missing: RequiredRepositoryCheckV1[] = [];
  const failed: RequiredRepositoryCheckV1[] = [];
  const notRun: Array<{
    check: RequiredRepositoryCheckV1;
    cause: RequiredCheckNotRunCause | null;
    reason: string | undefined;
    isolationRefusal: unknown;
  }> = [];
  for (const check of required.values()) {
    const entry = evidence.checks.find(
      (candidate) =>
        candidate.required === true &&
        candidate.command === check.command &&
        candidate.directory === check.directory,
    );
    if (!entry) missing.push(check);
    else if (entry.status === "failed") failed.push(check);
    else if (entry.status !== "passed")
      notRun.push({
        check,
        cause: isRequiredCheckNotRunCause(entry.cause) ? entry.cause : null,
        reason: typeof entry.reason === "string" ? entry.reason : undefined,
        isolationRefusal: entry.isolationRefusal,
      });
  }
  if (missing.length > 0) {
    return refused(
      "required-check-evidence-missing",
      `Host check evidence for run ${input.runId} omits ${describe(missing)}, which repository instructions require before proposing a change. The patch was not proposed. ${inspect} This is a runtime defect; do not retry unchanged.`,
    );
  }
  if (failed.length > 0) {
    return refused(
      "required-check-failed",
      `Repository-required check ${describe(failed)} failed on the proposed change, so the update is not validated and was not proposed. ${inspect} Next action: correct the candidate or the repository so the check passes, then start a new run; do not retry unchanged.`,
    );
  }
  const commands = [...required.values()].map((check) => check.command);
  if (notRun.length === 0) {
    return { status: "satisfied", snapshotSha256: final.sha256!, commands };
  }
  // Only an isolation cause carries a platform remedy, derived from the typed
  // refusals its evidence recorded, and only a declared bound (a timeout or the
  // credential scan) names its limit. Every other cause names no other host
  // and no setting.
  const isolation = notRun.filter((item) => item.cause === "isolation-unavailable");
  const platformRemedy =
    isolation.length > 0
      ? requiredCheckIsolationRemedy(isolation.map((item) => item.isolationRefusal))
      : undefined;
  return {
    status: "limited",
    snapshotSha256: final.sha256!,
    commands,
    limitations: notRun.map(({ check, cause, reason }) => {
      const remedy =
        cause === "isolation-unavailable"
          ? platformRemedy
          : cause === "timeout" || cause === "credential-scan-bound"
            ? reason
            : undefined;
      return {
        command: check.command,
        directory: check.directory,
        instruction: check.instruction,
        cause,
        ...(remedy !== undefined ? { remedy } : {}),
      };
    }),
  };
}

function parseCheckEvidence(
  summary: string | undefined,
): { snapshotSha256: string; checks: Array<Record<string, unknown>> } | undefined {
  if (!summary) return undefined;
  try {
    const parsed: unknown = JSON.parse(summary);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as { snapshotSha256?: unknown; checks?: unknown };
    if (typeof value.snapshotSha256 !== "string" || !Array.isArray(value.checks)) return undefined;
    return {
      snapshotSha256: value.snapshotSha256,
      checks: value.checks.filter(
        (check): check is Record<string, unknown> =>
          Boolean(check) && typeof check === "object" && !Array.isArray(check),
      ),
    };
  } catch {
    return undefined;
  }
}

function describe(checks: readonly RequiredRepositoryCheckV1[]): string {
  return checks
    .map((check) => `\`${check.command}\` (${check.instruction}, run from ${check.directory})`)
    .join(", ");
}

function refused(code: RequiredCheckRefusalCode, message: string): RequiredCheckGateResult {
  return { status: "refused", code, message: `${code}: ${message}` };
}
