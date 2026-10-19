// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { limit } from "../config/limits.js";
import {
  credentialFreeGitEnvironment,
  GIT_BINARY,
  SAFE_GIT_CONFIG,
} from "../repository/evidence.js";
import { redactSecrets } from "../security/redaction.js";

export const CHECK_ISOLATION_UNAVAILABLE =
  "Read-only, offline check isolation with bounded process lifetime is unavailable; no repository command ran. Required checks use Linux bubblewrap with working user namespaces or macOS Docker Desktop with the pinned image. Native macOS sandbox-exec cannot contain detached descendants.";
/** Credential path names; `.` matches a line break too, so no name slips past a pattern. */
export const CHECK_SECRET_NAME_PATTERN =
  /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.aws|\.ssh|\.config|credentials\.json|id_rsa.*|id_ed25519.*|.*\.(?:pem|key|keychain|keychain-db))$/su;
/**
 * Prints the first argument that is an executable regular file, or nothing.
 * It runs inside the sandbox with DocsFab's node, never repository code.
 */
const RESOLVE_EXECUTABLE_PROBE =
  "const fs=require('node:fs');for(const p of process.argv.slice(1)){try{if(fs.statSync(p).isFile()){fs.accessSync(p,fs.constants.X_OK);process.stdout.write(p);break}}catch{}}";
/**
 * Control characters the run-record publication reader refuses in a step
 * summary. Tab, line feed, and carriage return stay.
 */
const UNPUBLISHABLE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
/**
 * Per-command configuration for presenting Git metadata, after
 * `SAFE_GIT_CONFIG` (#1918), which already turns off automatic garbage
 * collection and maintenance: no CRLF safety warnings, which `git add` prints
 * once per file.
 */
const PRESENTATION_GIT_CONFIG = Object.freeze(["-c", "core.safecrlf=false"]);

/**
 * The declared bounds of one check command (#1932), in `config/limits/checks.yaml`.
 * A host may raise each one; none is a literal here.
 */
export const CHECK_COMMAND_TIMEOUT_LIMIT = "checks.commandTimeoutMs";
export const CHECK_OUTPUT_RETAINED_LIMIT = "checks.outputRetainedBytes";
export const CHECK_CREDENTIAL_SCAN_LIMIT = "checks.credentialScanMaxEntries";

export interface CheckCommandResult {
  status: "passed" | "failed" | "unavailable";
  exitCode: number | null;
  /** The output the command wrote, or its retained head and tail with a marker between. */
  output: string;
  reason?: "timeout" | "cancelled" | "launch-failed";
  /** Bytes the command wrote; present only when `output` omits some of them. */
  outputBytes?: number;
  /** Bytes omitted between the retained head and tail of `output`. */
  outputOmittedBytes?: number;
  /** For a `timeout`: the time limit the executor applied, in ms. */
  timeoutMs?: number;
  /** For a `timeout`: how long the command ran before the executor stopped it, in ms. */
  elapsedMs?: number;
}

/**
 * - `bubblewrap-unavailable`: the host is not Linux, `/usr/bin/bwrap` is
 *   absent, or bubblewrap could not start the readiness probe.
 * - `host-preparation`: host inputs failed before bubblewrap ran (repository
 *   or runtime path, scratch directory, or a credential scan that could not
 *   read the checkout).
 * - `credential-scan-bound`: the credential scan passed
 *   `checks.credentialScanMaxEntries`; `observed` is the entry it stopped at.
 * - `git-metadata`: DocsFab could not present Git metadata for the checked copy.
 */
export type CheckSandboxFailureStage =
  | "bubblewrap-unavailable"
  | "host-preparation"
  | "credential-scan-bound"
  | "git-metadata";

/** A typed `prepareCheckSandbox` failure; its message never names host paths. */
export class CheckSandboxPreparationError extends Error {
  public readonly stage: CheckSandboxFailureStage;
  /** For `credential-scan-bound`: the entry count at which the scan stopped. */
  public readonly observed?: number;

  public constructor(stage: CheckSandboxFailureStage, observed?: number) {
    super(CHECK_ISOLATION_UNAVAILABLE);
    this.name = "CheckSandboxPreparationError";
    this.stage = stage;
    if (observed !== undefined) this.observed = observed;
  }
}

const bubblewrapUnavailable = () => new CheckSandboxPreparationError("bubblewrap-unavailable");
const hostPreparation = () => new CheckSandboxPreparationError("host-preparation");
const credentialScanBound = (observed: number) =>
  new CheckSandboxPreparationError("credential-scan-bound", observed);
const gitMetadataUnavailable = () => new CheckSandboxPreparationError("git-metadata");

/** No inherited environment, writable checkout, host HOME, or network. */
export async function prepareCheckSandbox(repository: string) {
  // sandbox-exec cannot keep detached posix_spawn descendants in a killable
  // group, so fail closed rather than run code that can outlive its deadline.
  if (process.platform !== "linux") throw bubblewrapUnavailable();
  const executable = "/usr/bin/bwrap";
  await access(executable).catch(() => {
    throw bubblewrapUnavailable();
  });
  // The declared bounds, resolved once for this sandbox (#1932). Startup has
  // already validated any host override of them.
  const commandTimeoutMs = limit(CHECK_COMMAND_TIMEOUT_LIMIT).value;
  const retainedOutputBytes = limit(CHECK_OUTPUT_RETAINED_LIMIT).value;
  const credentialScanMaxEntries = limit(CHECK_CREDENTIAL_SCAN_LIMIT).value;
  // Host inputs that fail before bubblewrap runs are not bubblewrap faults.
  const root = await realpath(repository).catch(() => {
    throw hostPreparation();
  });
  const node = await realpath(process.execPath).catch(() => {
    throw hostPreparation();
  });
  const runtime = dirname(dirname(node));
  const scratch = await mkdtemp(join(tmpdir(), "docsfab-check-"))
    .then((created) => realpath(created))
    .catch(() => {
      throw hostPreparation();
    });
  /** The Git metadata this sandbox created, which cleanup removes; never a `.git` it found. */
  let presentedGit: string | undefined;
  /**
   * Removes the scratch directory and the presented Git metadata, trying both,
   * then rejects with the first failure. The caller records it; it never fails
   * a run (#1918).
   */
  const cleanup = async () => {
    const failures: unknown[] = [];
    for (const path of [scratch, presentedGit]) {
      if (path) {
        await rm(path, { recursive: true, force: true }).catch((error: unknown) => {
          failures.push(error);
        });
      }
    }
    if (failures.length > 0) throw failures[0];
  };
  const env = checkSandboxEnvironment(node, scratch);
  try {
    const mountedReadRoots = await presentPaths(checkSandboxReadRoots(root, runtime));
    const hidden = await credentialPaths(root, credentialScanMaxEntries).catch((error: unknown) => {
      throw error instanceof CheckSandboxPreparationError ? error : hostPreparation();
    });
    // A `.git` the copy already holds is not DocsFab's: it stays masked, and
    // the checks run without metadata.
    const rootGit = join(root, ".git");
    const gitMetadata = !hidden.some((entry) => entry.path === rootGit);
    const args = checkSandboxBubblewrapArgs({ mountedReadRoots, scratch, hidden });
    const run = (
      command: string,
      argv: readonly string[],
      options: {
        cwd?: string;
        timeoutMs?: number;
        retainedOutputBytes?: number;
        signal?: AbortSignal;
      } = {},
    ) =>
      runBoundedCheckCommand(
        executable,
        [...args, "--chdir", options.cwd ?? root, "--", command, ...argv],
        {
          env,
          cwd: options.cwd ?? root,
          // A caller may tighten a bound, never widen it past the declared limit.
          timeoutMs: Math.min(options.timeoutMs ?? commandTimeoutMs, commandTimeoutMs),
          retainedOutputBytes: Math.min(
            options.retainedOutputBytes ?? retainedOutputBytes,
            retainedOutputBytes,
          ),
          signal: options.signal,
        },
      );
    // DocsFab's own readiness probe; its output is DocsFab's protocol, not a check's.
    const probe = await run(node, ["-e", "process.stdout.write('ready')"], { timeoutMs: 5000 });
    if (probe.status !== "passed" || probe.output !== "ready") throw bubblewrapUnavailable();
    // Git metadata for the checked copy (#1918), once bubblewrap is known to
    // start, and after the credential scan, so it is never masked. The bind
    // mount of the copy shows it to every later launch.
    if (gitMetadata) {
      presentedGit = rootGit;
      await presentCheckedGitMetadata(
        root,
        commandTimeoutMs,
        hidden.map((entry) => entry.path),
      ).catch(() => {
        throw gitMetadataUnavailable();
      });
    }
    /**
     * Pre-flight resolution inside the sandbox, before a check runs (#1918):
     * the first candidate that is an executable regular file in the sandbox's
     * own mount view, symlinks followed there, or `undefined`.
     */
    const resolveExecutable = async (candidates: readonly string[]) => {
      // Bounded like a check, by the declared command limit, so a probe that is
      // only slow on a loaded host still answers rather than reading as absent.
      const resolved = await run(node, ["-e", RESOLVE_EXECUTABLE_PROBE, ...candidates]);
      return resolved.status === "passed" && candidates.includes(resolved.output)
        ? resolved.output
        : undefined;
    };
    /** The `PATH` directories a check's processes search inside the sandbox. */
    const searchPath = Object.freeze(String(env.PATH).split(":"));
    return { run, resolveExecutable, searchPath, gitMetadata, cleanup, node, runtime };
  } catch (error) {
    // The preparation failure is what the run records; a scratch directory or
    // Git metadata left behind is removed with the run's workspace or TMPDIR.
    await cleanup().catch(() => undefined);
    // Typed stages keep their stage; anything else came from launching the
    // readiness probe.
    throw error instanceof CheckSandboxPreparationError ? error : bubblewrapUnavailable();
  }
}

/**
 * A throwaway repository over the checked copy (#1918): `git init` with no
 * template, then one commit of every file the sandbox shows, with DocsFab's
 * fixed identity, in the credential-free Git environment. It has no remote,
 * copied config, or hook. The sandbox mounts it read-only with the rest of the
 * checked copy, so a check that calls Git sees the checked tree as its `HEAD`.
 *
 * `masked` lists the paths the sandbox masks. The commit leaves them out, and
 * `.git/info/exclude` names them, so no masked content is reachable from
 * `HEAD` and the masked view is a clean working tree. Each command is bounded
 * by the declared check command timeout, and its output is discarded. The
 * caller removes `<root>/.git` when the checks are done.
 */
export async function presentCheckedGitMetadata(
  root: string,
  timeoutMs: number,
  masked: readonly string[] = [],
): Promise<void> {
  const git = (args: readonly string[]) => presentationGit(root, args, timeoutMs);
  await git(["-c", "init.defaultBranch=main", "init", "--quiet", "--template="]);
  const relativeMasked = masked.map((path) => relative(root, path).split(sep).join("/"));
  const info = join(root, ".git", "info");
  await mkdir(info, { recursive: true });
  await writeFile(join(info, "exclude"), relativeMasked.map(excludePattern).join(""));
  // NUL-separated pathspecs, so any path name excludes exactly itself.
  const pathspecs = join(root, ".git", "docsfab-add-pathspecs");
  await writeFile(
    pathspecs,
    [".", ...relativeMasked.map((path) => `:(exclude,literal)${path}`)]
      .map((pathspec) => `${pathspec}\0`)
      .join(""),
  );
  await git([
    "add",
    "--all",
    "--force",
    `--pathspec-from-file=${pathspecs}`,
    "--pathspec-file-nul",
  ]);
  await rm(pathspecs, { force: true });
  await git([
    "-c",
    "user.name=DocsFab",
    "-c",
    "user.email=docsfab@example.invalid",
    "commit",
    "--quiet",
    "--no-verify",
    "--no-gpg-sign",
    "--allow-empty",
    "--message",
    "DocsFab checked tree",
  ]);
}

/**
 * One anchored `.git/info/exclude` line that matches `path`: its glob
 * characters escaped, and a line break, which that file cannot hold, matched
 * by `?`, which any masked name with it there matches too.
 */
function excludePattern(path: string): string {
  const escaped = path
    .replace(/[\\*?[]/gu, "\\$&")
    .replace(/[\r\n]/gu, "?")
    .replace(/ +$/u, (spaces) => spaces.replaceAll(" ", "\\ "));
  return `/${escaped}\n`;
}

/**
 * One Git command of the presentation, with stdin, stdout, and stderr
 * discarded so no amount of output can fail it, stopped at `timeoutMs`.
 */
function presentationGit(root: string, args: readonly string[], timeoutMs: number) {
  return new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(
      GIT_BINARY,
      [...SAFE_GIT_CONFIG, ...PRESENTATION_GIT_CONFIG, "-C", root, ...args],
      {
        env: credentialFreeGitEnvironment(),
        stdio: "ignore",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );
    child.once("error", rejectCommand);
    child.once("close", (code, signal) => {
      if (code === 0) resolveCommand();
      else rejectCommand(new Error(`Git presentation ended with ${code ?? signal}.`));
    });
  });
}

/**
 * Every credential path under `root`, to mask before any check runs. A walk
 * past `maxEntries` (`checks.credentialScanMaxEntries`) refuses with the entry
 * it stopped at, so no check ever runs beside an unscanned file.
 */
async function credentialPaths(root: string, maxEntries: number) {
  const hidden: Array<{ path: string; directory: boolean }> = [];
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > maxEntries) throw credentialScanBound(count);
      const path = join(directory, entry.name);
      if (CHECK_SECRET_NAME_PATTERN.test(entry.name))
        hidden.push({ path, directory: entry.isDirectory() });
      else if (entry.isDirectory()) pending.push(path);
      // Symlinks cannot grant access beyond the explicitly mounted/readable roots.
    }
  }
  return hidden;
}

/** The read roots present on this host, in declaration order. */
async function presentPaths(paths: readonly string[]) {
  const present: string[] = [];
  for (const path of paths) {
    try {
      await access(path);
      present.push(path);
    } catch {
      /* Optional OS root. */
    }
  }
  return present;
}

/** Read-only roots a required check may see, before host presence filtering. */
export function checkSandboxReadRoots(root: string, runtime: string): string[] {
  return [
    ...new Set([
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/usr/bin",
      "/usr/sbin",
      "/usr/lib",
      "/usr/lib64",
      "/usr/share",
      "/usr/local/bin",
      "/usr/local/lib",
      "/usr/local/share",
      join(runtime, "bin"),
      join(runtime, "lib"),
      join(runtime, "share"),
      root,
    ]),
  ];
}

/**
 * The complete environment a required check receives; nothing is inherited.
 * `PATH` lists only read roots the sandbox mounts, including `/usr/local/bin`,
 * so a tool installed there is found as it is outside the sandbox (#1918).
 */
export function checkSandboxEnvironment(node: string, scratch: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    LANG: "C",
    CI: "1",
    NO_COLOR: "1",
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_offline: "true",
    npm_config_userconfig: join(scratch, "npm-userconfig"),
    npm_config_globalconfig: join(scratch, "npm-globalconfig"),
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    PYTHONDONTWRITEBYTECODE: "1",
    OPENSSL_CONF: "/dev/null",
  };
}

/**
 * Pure Linux bubblewrap argv for required checks, before `--chdir` and the
 * command: offline (`--unshare-all`), its own session for process-group
 * teardown, read-only host roots, one writable scratch, and credential paths
 * masked. Host paths are injected so the argv is testable on any platform.
 */
export function checkSandboxBubblewrapArgs(input: {
  readonly mountedReadRoots: readonly string[];
  readonly scratch: string;
  readonly hidden: ReadonlyArray<{ readonly path: string; readonly directory: boolean }>;
}): string[] {
  return [
    "--die-with-parent",
    "--unshare-all",
    "--new-session",
    ...input.mountedReadRoots.flatMap((path) => ["--ro-bind", path, path]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--bind",
    input.scratch,
    input.scratch,
    ...input.hidden.flatMap(({ path, directory }) =>
      directory ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path],
    ),
  ];
}

/**
 * Runs one command in its own process group, stopped with that group at
 * `timeoutMs`, on cancellation, and after it exits. Output volume never stops
 * a command (#1932): `output` keeps the first and last halves of
 * `retainedOutputBytes`, and a marker between them names the omitted bytes.
 * The Linux sandbox runs bubblewrap through it; nothing here isolates.
 */
export function runBoundedCheckCommand(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    retainedOutputBytes: number;
    signal?: AbortSignal;
  },
): Promise<CheckCommandResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ status: "unavailable", exitCode: null, output: "", reason: "cancelled" });
      return;
    }
    const started = Date.now();
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = retainedOutput(options.retainedOutputBytes);
    let reason: CheckCommandResult["reason"];
    let settled = false;
    let forceClose: ReturnType<typeof setTimeout> | undefined;
    const stop = (why: CheckCommandResult["reason"]) => {
      reason ??= why;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      child.stdout.destroy();
      child.stderr.destroy();
      // Never depend on a descendant closing inherited pipes to honor the deadline.
      forceClose ??= setTimeout(() => finish(null), 250);
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", output.append);
    child.stderr.on("data", output.append);
    child.on("error", () => {
      reason = "launch-failed";
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceClose) clearTimeout(forceClose);
      options.signal?.removeEventListener("abort", abort);
      // Also reap descendants that outlive their direct parent.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      child.unref();
      const omitted = output.omitted();
      resolve({
        status:
          reason === "launch-failed" || reason === "cancelled"
            ? "unavailable"
            : code === 0 && !reason
              ? "passed"
              : "failed",
        exitCode: code,
        // Control bytes would make the run record unpublishable (#1932).
        output: redactSecrets(output.text(), []).replace(UNPUBLISHABLE_CONTROL, "\ufffd"),
        ...(reason ? { reason } : {}),
        ...(omitted > 0 ? { outputBytes: output.total(), outputOmittedBytes: omitted } : {}),
        ...(reason === "timeout"
          ? { timeoutMs: options.timeoutMs, elapsedMs: Date.now() - started }
          : {}),
      });
    };
    child.on("close", finish);
  });
}

/**
 * Keeps the first and last halves of a byte budget from a stream, and counts
 * what falls between them, so a long output costs bounded memory and record
 * space without stopping its writer.
 */
function retainedOutput(budgetBytes: number) {
  const headBytes = Math.ceil(budgetBytes / 2);
  const tailBytes = budgetBytes - headBytes;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let total = 0;
  const omitted = () => total - head.length - tail.length;
  return {
    append: (chunk: Buffer) => {
      total += chunk.length;
      let rest = chunk;
      if (head.length < headBytes) {
        const take = Math.min(headBytes - head.length, rest.length);
        head = Buffer.concat([head, rest.subarray(0, take)]);
        rest = rest.subarray(take);
      }
      if (rest.length > 0 && tailBytes > 0) {
        const joined = Buffer.concat([tail, rest]);
        // Copy, so a large chunk is not kept alive behind a small tail view.
        tail = Buffer.from(joined.subarray(Math.max(0, joined.length - tailBytes)));
      }
    },
    total: () => total,
    omitted,
    text: () =>
      omitted() > 0
        ? `${head.toString("utf8")}\n[${omitted()} bytes of output omitted]\n${tail.toString("utf8")}`
        : Buffer.concat([head, tail]).toString("utf8"),
  };
}
