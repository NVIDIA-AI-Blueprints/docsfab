// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";

import type { ReadOnlyCommandResult, ReadOnlyCommandRunner } from "../delivery/preflight.js";

interface SafeCommandResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

type CredentialProbeStatus = "present" | "missing" | "unverified";

export interface DoctorReadinessCommandRunner {
  run(
    command: "git" | "glab" | "gh" | "npm",
    args: readonly string[],
    cwd: string,
  ): Promise<SafeCommandResult>;
  probeCredential(
    command: "glab",
    args: readonly string[],
    cwd: string,
  ): Promise<CredentialProbeStatus>;
}

export class ExecDoctorReadinessCommandRunner implements DoctorReadinessCommandRunner {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}

  run(
    command: "git" | "glab" | "gh" | "npm",
    args: readonly string[],
    cwd: string,
  ): Promise<SafeCommandResult> {
    if (command === "gh") {
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Doctor does not support gh." });
    }
    return new Promise((complete) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          env: diagnosticCommandEnvironment(this.environment, command, args),
        },
        (error, stdout, stderr) =>
          complete({
            exitCode: error ? 1 : 0,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
          }),
      );
    });
  }

  probeCredential(
    command: "glab",
    args: readonly string[],
    cwd: string,
  ): Promise<CredentialProbeStatus> {
    return new Promise((complete) => {
      const child = spawn(command, [...args], {
        cwd,
        stdio: "ignore",
        env: diagnosticCommandEnvironment(this.environment, command, args, true),
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        complete("unverified");
      }, 5_000);
      child.once("error", () => {
        clearTimeout(timer);
        complete("unverified");
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (signal) complete("unverified");
        else complete(code === 0 ? "present" : code === 1 ? "missing" : "unverified");
      });
    });
  }
}

/**
 * Read-only git/glab runner for the shared GitLab target observation.
 * Same scrubbed diagnostic environment as the rest of doctor; the caller's
 * hardened `env` (the publication path's git environment) wins.
 */
export class ExecDoctorPublicationCommandRunner implements ReadOnlyCommandRunner {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}

  run(
    command: "git" | "glab" | "gh",
    args: readonly string[],
    cwd: string,
    options: { env?: NodeJS.ProcessEnv } = {},
  ): Promise<ReadOnlyCommandResult> {
    if (command === "gh") {
      return Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "Doctor GitLab observation does not support gh.",
      });
    }
    return new Promise((complete) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          // A caller-supplied environment wins: `observeLocalUserGitLabTarget`
          // passes the publication path's `gitEnvironment()` for git, which is
          // stricter than the diagnostic scrub (it pins HOME and
          // XDG_CONFIG_HOME to /dev/null). glab calls supply no environment and
          // take the scrubbed branch.
          env: options.env ?? diagnosticCommandEnvironment(this.environment, command, args),
        },
        (error, stdout, stderr) =>
          complete({
            exitCode: error ? 1 : 0,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
          }),
      );
    });
  }
}

function diagnosticCommandEnvironment(
  environment: NodeJS.ProcessEnv,
  command: "git" | "glab" | "npm",
  args: readonly string[],
  credentialProbe = false,
): NodeJS.ProcessEnv {
  const common = ["PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "LC_ALL"] as const;
  const names = command === "glab" ? [...common, "GLAB_CONFIG_DIR", "GITLAB_HOST"] : [...common];
  if (
    command === "glab" &&
    ((args[0] === "auth" && args[1] === "status") || args[0] === "api" || credentialProbe)
  ) {
    // `glab api` is exactly as credential-scoped as `auth status`: the GitLab
    // target observation needs the same host-managed token.
    names.push("GLAB_TOKEN", "GITLAB_TOKEN");
  }
  const result = Object.fromEntries(
    names.flatMap((name) => (environment[name] === undefined ? [] : [[name, environment[name]]])),
  ) as NodeJS.ProcessEnv;
  result.GIT_TERMINAL_PROMPT = "0";
  result.GIT_ASKPASS = "/usr/bin/false";
  result.SSH_ASKPASS = "/usr/bin/false";
  result.GIT_PAGER = "cat";
  result.GLAB_CHECK_UPDATE = "false";
  result.NO_COLOR = "1";
  return result;
}
