// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  formatLimitObservation,
  limit,
  limitDefinition,
  type ResolvedLimit,
} from "../config/limits.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";
import { egressText, type HostRootSet } from "../security/egress.js";
import { processHostRootSet } from "../security/host-roots.js";
import { declaredPublicRoots } from "../security/public-roots.js";
import {
  DocumentationScope,
  liveCommandScopeNote,
  SANDBOX_WRITE_REFUSAL,
} from "./documentation-scope.js";
import {
  CONFIGURATION_CREDENTIALS_FAILURE,
  documentationCommandSandbox,
  DOCUMENTATION_SANDBOX_FAILURE,
  WORKTREE_GIT_STATE_FAILURES,
} from "./command-sandbox.js";
import type { CommandApproval } from "./command-approval.js";

export const LIVE_COMMAND_FAILURES = {
  isolation: DOCUMENTATION_SANDBOX_FAILURE,
  configurationUnreadable: CONFIGURATION_CREDENTIALS_FAILURE,
  readonly: "Host commands are disabled in read-only mode. Restart with --allow-write.",
  input: "Provide a non-empty command and a timeout between 1 and 1800 seconds.",
  busy: "Another host command is active. Wait for its result before continuing.",
  credentials:
    "Command data contained one of DocsFab's own configured credentials and was withheld.",
  unavailable:
    "The host command could not start. Check the repository and local shell installation.",
  timeout: "The host command timed out and was stopped. Inspect repository state before retrying.",
  output:
    "The host command exceeded its output limit and was stopped. Narrow its output before retrying.",
  cancelled: "The host command was cancelled. Inspect repository state before retrying.",
  processStop:
    "The host command ended, but a process it started could not be stopped. End it before retrying.",
  gitCommondir: WORKTREE_GIT_STATE_FAILURES.commondir,
  gitGitdir: WORKTREE_GIT_STATE_FAILURES.gitdir,
  gitConfigWorktree: WORKTREE_GIT_STATE_FAILURES["config.worktree"],
  gitIrregular: WORKTREE_GIT_STATE_FAILURES.irregular,
  gitNestedRepository: WORKTREE_GIT_STATE_FAILURES.nestedRepository,
  gitGitlink: WORKTREE_GIT_STATE_FAILURES.gitlink,
  gitGitmodules: WORKTREE_GIT_STATE_FAILURES.gitmodules,
  gitDocumentationUnrepairable: WORKTREE_GIT_STATE_FAILURES.documentationUnrepairable,
  gitIndexUnreadable: WORKTREE_GIT_STATE_FAILURES.indexUnreadable,
  gitIndexUnrestorable: WORKTREE_GIT_STATE_FAILURES.indexUnrestorable,
} as const;

/** Bounds how long the host keeps ending a finished command's remaining processes. */
export const COMMAND_PROCESS_STOP_LIMIT = "liveAgent.commandProcessStopMs";

/** Bounds the combined stdout and stderr bytes of one command. */
export const COMMAND_OUTPUT_LIMIT = "liveAgent.commandOutputBytes";

/** The `processStop` refusal with the catalogued limit and the observed time. */
export function commandProcessStopRefusal(bound: ResolvedLimit, observedMs: number): string {
  return `${LIVE_COMMAND_FAILURES.processStop} ${formatLimitObservation(bound, observedMs)}`;
}

/** True only for text `commandProcessStopRefusal` produces, at any configured value. */
export function isCommandProcessStopRefusal(message: string): boolean {
  const numbers = / (\d{1,9}) exceeds \S+ = (\d{1,9}) /u.exec(message);
  if (!numbers) return false;
  const bound = {
    ...limitDefinition(COMMAND_PROCESS_STOP_LIMIT),
    value: Number(numbers[2]),
    source: "config/limits.yaml" as const,
  };
  return message === commandProcessStopRefusal(bound, Number(numbers[1]));
}

/** Interactive host execution, not the confined filesystem or workflow sandbox. */
export function createLiveCommandTool(options: {
  repositoryPath: string;
  allowWrite: boolean;
  environment?: NodeJS.ProcessEnv;
  confirm: (request: CommandApproval) => Promise<boolean>;
  documentationScope?: DocumentationScope;
  /**
   * Host-held admission check invoked before the approval prompt, so the
   * operator is never asked to approve a command the host will refuse.
   */
  beforeApproval?: (toolCallId: string) => void;
  /** Host-held gate invoked after approval and before the command can write. */
  beforeMutation?: (toolCallId: string) => Promise<void>;
}): ToolDefinition {
  const processStop = limit(COMMAND_PROCESS_STOP_LIMIT, {
    environment: options.environment ?? process.env,
  });
  const outputBytes = limit(COMMAND_OUTPUT_LIMIT, {
    environment: options.environment ?? process.env,
  });
  // Parsed with the tool, so an invalid declaration refuses before any command runs.
  const publicRoots = options.environment ? declaredPublicRoots(options.environment) : undefined;
  const documentationScope = options.documentationScope ?? new DocumentationScope();
  let active = false;
  return {
    name: "bash",
    label: "Run host command",
    description:
      "Run a terminal-approved command with documentation-only filesystem writes. Use for checks and Git/gh/glab publication of documentation changes, including manual edits. No workflow run is required. Source code, CI, and unrelated configuration are read-only even after approval. Git metadata and private temporary files are writable for operation. Use $TMPDIR for temporary files; npm_config_cache already points inside it. Do not relocate caches to the repository root, home directory, or arbitrary /tmp paths. Temporary files and caches are removed after each command. Do not start servers, watchers, or other long-running background processes: once the command exits, the ones still in its process group are stopped before its result returns. For dependent validation batches, use set -e -o pipefail or join commands with && so an earlier failed check cannot be hidden by a successful final command. Use edit/write to create new documentation directories first. Never read or print credentials. Inspect intended documentation changes and destination before publishing; preserve unrelated work and staged changes. Do not merge or perform destructive actions without specific authorization.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", description: "Exact Bash command to show for approval." },
        timeout: {
          type: "integer",
          minimum: 1,
          maximum: 1800,
          description: "Seconds; default 120.",
        },
      },
    },
    async execute(toolCallId, raw, signal) {
      if (!options.allowWrite) throw new Error(LIVE_COMMAND_FAILURES.readonly);
      const input = raw as { command?: unknown; timeout?: unknown };
      const command = input?.command;
      const timeout = input?.timeout ?? 120;
      if (
        typeof command !== "string" ||
        !command.trim() ||
        command.length > 16_000 ||
        /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(command) ||
        typeof timeout !== "number" ||
        !Number.isInteger(timeout) ||
        timeout < 1 ||
        timeout > 1800 ||
        Object.keys(input).some((key) => key !== "command" && key !== "timeout")
      )
        throw new Error(LIVE_COMMAND_FAILURES.input);
      screen(command);
      if (active) throw new Error(LIVE_COMMAND_FAILURES.busy);
      active = true;
      try {
        if (signal?.aborted) return result("cancelled", LIVE_COMMAND_FAILURES.cancelled);
        const cwd = await realpath(options.repositoryPath).catch(() => {
          throw new Error(LIVE_COMMAND_FAILURES.unavailable);
        });
        screen(cwd);
        options.beforeApproval?.(toolCallId);
        const approved = await options.confirm({ kind: "command", repositoryPath: cwd, command });
        if (!approved || signal?.aborted)
          return result("cancelled", LIVE_COMMAND_FAILURES.cancelled);
        // Isolation is set up before the mutation gate: when the sandbox is
        // unavailable no command runs and branch preparation has not switched
        // the checkout. A gate refusal still removes the private scratch.
        const sandbox = await documentationCommandSandbox(
          cwd,
          documentationScope,
          options.environment ?? process.env,
        );
        let output: { code: number; text: string };
        try {
          await options.beforeMutation?.(toolCallId);
          output = await executeCommand(
            command,
            cwd,
            {
              ...commandEnvironment(options.environment ?? process.env),
              TMPDIR: sandbox.scratch,
              TMP: sandbox.scratch,
              TEMP: sandbox.scratch,
              npm_config_cache: join(sandbox.scratch, "npm-cache"),
            },
            timeout,
            signal,
            sandbox,
            processStop,
            outputBytes,
          );
        } finally {
          try {
            // Before any result, timeout, or cancellation reaches the model or delivery.
            await sandbox.restoreGitState();
          } finally {
            await sandbox.cleanup();
          }
        }
        screen(output.text);
        // After the output bound, over the whole text: a root split across chunks is still found.
        const projected = egressText(
          output.text,
          await commandOutputRoots({
            repositoryPath: options.repositoryPath,
            cwd,
            scratch: sandbox.scratch,
            environment: options.environment,
            publicRoots,
          }),
        );
        if (!projected.ok) throw new Error(LIVE_COMMAND_FAILURES.credentials);
        const scopeNote =
          output.code !== 0 && SANDBOX_WRITE_REFUSAL.test(projected.text)
            ? `\n${liveCommandScopeNote(documentationScope)}`
            : "";
        return result(
          output.code === 0 ? "succeeded" : "failed",
          `Command exited with code ${output.code}.\n${projected.text}${scopeNote}`,
          output.code,
        );
      } finally {
        active = false;
      }
    },
  };
}

function screen(value: string): void {
  try {
    assertConfinedToolResultCredentialFree(value);
  } catch {
    throw new Error(LIVE_COMMAND_FAILURES.credentials);
  }
}

/**
 * The command ran in the real checkout with a private `TMPDIR`. Both are roots,
 * and so is a linked worktree's main checkout, which Git names for shared state.
 */
async function commandOutputRoots(input: {
  repositoryPath: string;
  cwd: string;
  scratch: string;
  environment: NodeJS.ProcessEnv | undefined;
  publicRoots: ReadonlySet<string> | undefined;
}): Promise<HostRootSet> {
  const main = await linkedWorktreeMainCheckout(input.cwd);
  return processHostRootSet({
    workspaceRoots: [input.repositoryPath, input.cwd, ...(main ? [main] : [])],
    roots: [{ kind: "tmp", path: input.scratch }],
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.publicRoots ? { publicRoots: input.publicRoots } : {}),
  });
}

/**
 * Reads Git's pointer files instead of running Git, which would execute
 * configuration the command could have written.
 */
async function linkedWorktreeMainCheckout(worktree: string): Promise<string | undefined> {
  const pointer = await readFile(join(worktree, ".git"), "utf8").catch(() => "");
  const gitDir = /^gitdir: (.+)$/mu.exec(pointer)?.[1];
  if (!gitDir) return undefined;
  const admin = resolve(worktree, gitDir);
  const common = (await readFile(join(admin, "commondir"), "utf8").catch(() => "")).trim();
  if (!common) return undefined;
  const metadata = resolve(admin, common);
  return basename(metadata) === ".git" ? dirname(metadata) : undefined;
}

function result(status: string, text: string, exitCode?: number) {
  return {
    content: [{ type: "text" as const, text }],
    details: { status, ...(exitCode === undefined ? {} : { exitCode }) },
  };
}

/** Local CLI config/credential helpers remain usable; model secrets are not inherited. */
function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "GLAB_CONFIG_DIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (source[key]) env[key] = source[key];
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GLAB_NO_PROMPT: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
  };
}

function executeCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  signal: AbortSignal | undefined,
  sandbox: { executable: string; args: string[] },
  processStop: ResolvedLimit,
  outputBytes: ResolvedLimit,
): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      sandbox.executable,
      [...sandbox.args, "/bin/bash", "--noprofile", "--norc", "-c", command],
      {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: string | undefined;
    const stop = (reason: string) => {
      failure ??= reason;
      if (child.pid) signalGroup(child.pid, "SIGKILL");
    };
    const abort = () => stop(LIVE_COMMAND_FAILURES.cancelled);
    const timer = setTimeout(() => stop(LIVE_COMMAND_FAILURES.timeout), timeout * 1000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > outputBytes.value) stop(LIVE_COMMAND_FAILURES.output);
      else if (!failure) chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => {
      failure = LIVE_COMMAND_FAILURES.unavailable;
    });
    // Ends the group as soon as the command exits, so a background process that keeps the
    // output open does not delay `close` until the timeout.
    child.on("exit", () => {
      if (child.pid) signalGroup(child.pid, "SIGKILL");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      endProcessGroup(child.pid, processStop).then(() => {
        if (failure) reject(new Error(failure));
        else
          resolve({
            code: code ?? 1,
            text: stripVTControlCharacters(Buffer.concat(chunks).toString("utf8")),
          });
      }, reject);
    });
  });
}

/** Execution plumbing: how often the host looks for the command's remaining processes. */
const PROCESS_GROUP_POLL_MS = 10;

/**
 * Kills every process left in the command's process group before the host checks the result.
 * The command is the group leader (`detached`). On a loaded macOS host one kill of the group
 * can miss a member, so the kill repeats until the group no longer accepts it, and refuses
 * once that takes longer than `bound`. On Linux, bwrap's PID namespace has already ended
 * every process by the time the command exits.
 */
async function endProcessGroup(pid: number | undefined, bound: ResolvedLimit): Promise<void> {
  if (!pid) return;
  const started = performance.now();
  while (signalGroup(pid, "SIGKILL")) {
    const elapsed = Math.ceil(performance.now() - started);
    if (elapsed > bound.value) throw new Error(commandProcessStopRefusal(bound, elapsed));
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
  }
}

/** Signals the command's process group; false once no process in it can receive a signal. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Handles only: the group is empty (ESRCH), or no member in it accepts a signal from this
    // user (EPERM). macOS returns EPERM for a group whose members have all exited but are not
    // reaped yet. A running member owned by another user also ends the loop here, and keeps
    // running.
    if (code === "ESRCH" || code === "EPERM") return false;
    throw error;
  }
}
