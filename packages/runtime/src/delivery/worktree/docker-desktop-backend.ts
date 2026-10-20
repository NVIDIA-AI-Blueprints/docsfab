// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Darwin Docker Desktop validation backend. Host-selected; interchangeable with
 * Linux Bubblewrap only at the backend capability/attestation boundary. Plan,
 * config, environment, CLI, and model output cannot construct this argv.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import { failValidationBackend } from "./validation-backend.js";

export const DARWIN_DOCKER_DESKTOP_BACKEND_IDENTITY = "darwin-docker-desktop" as const;

export const DARWIN_DOCKER_DESKTOP_IMAGE_NAME = "node" as const;
export const DARWIN_DOCKER_DESKTOP_IMAGE_TAG = "24.21.0-bookworm" as const;
export const DARWIN_DOCKER_DESKTOP_IMAGE_DIGEST =
  "sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4" as const;
export const DARWIN_DOCKER_DESKTOP_IMAGE =
  `${DARWIN_DOCKER_DESKTOP_IMAGE_NAME}:${DARWIN_DOCKER_DESKTOP_IMAGE_TAG}@${DARWIN_DOCKER_DESKTOP_IMAGE_DIGEST}` as const;

export const DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT = "/input" as const;
export const DARWIN_DOCKER_DESKTOP_SCRATCH_ROOT = "/scratch" as const;
export const DARWIN_DOCKER_DESKTOP_CLI = "docker" as const;

/** Isolation-policy resource and PID bounds, expressed as Docker cgroup/namespace flags. */
export const DARWIN_DOCKER_DESKTOP_RESOURCE_LIMITS = Object.freeze({
  memory: "512m",
  memorySwap: "512m",
  cpus: "1",
  pidsLimit: "256",
  tmpfsTmp: "/tmp:rw,noexec,nosuid,nodev,size=64m",
});

export const DARWIN_DOCKER_DESKTOP_UNAVAILABLE_DIAGNOSTIC =
  "Docker Desktop validation is unavailable. Start Docker Desktop, load the pinned image from deploy/compose/docker-desktop-validation.yaml, then retry; the preserved patch was not applied to the source checkout.";

export const DARWIN_DOCKER_DESKTOP_CONTAINER_ENV = Object.freeze([
  "HOME=/scratch",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "TMPDIR=/scratch/tmp",
  "CI=1",
  "NO_COLOR=1",
  "GIT_CONFIG_GLOBAL=/dev/null",
  "GIT_CONFIG_SYSTEM=/dev/null",
  "GIT_TERMINAL_PROMPT=0",
  "GIT_ALLOW_PROTOCOL=file",
  "npm_config_offline=true",
  "npm_config_audit=false",
  "npm_config_fund=false",
]);

const CREDENTIAL_ENV_PATTERN =
  /token|secret|password|api[_-]?key|authorization|ssh_auth|gitlab|ngc|docker_host|credential/iu;

export interface DarwinDockerDesktopIsolationHost {
  readonly worktreePath: string;
  readonly scratchPath: string;
  readonly deniedReadPaths?: readonly string[];
  readonly deniedReadRoots?: readonly string[];
}

export interface DarwinDockerDesktopUserIdentity {
  readonly uid: number;
  readonly gid: number;
}

export function darwinDockerDesktopHostUser(): DarwinDockerDesktopUserIdentity {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) failValidationBackend("backend-unavailable");
  return { uid, gid };
}

/**
 * Unlike Bubblewrap, which keeps host paths, this remaps the candidate tree to
 * read-only /input and scratch to /scratch, on a read-only root plus tmpfs /tmp.
 */
export function darwinDockerDesktopValidationArgv(
  host: DarwinDockerDesktopIsolationHost,
  identity: DarwinDockerDesktopUserIdentity = darwinDockerDesktopHostUser(),
): string[] {
  const worktreePath = resolve(host.worktreePath);
  const scratchPath = resolve(host.scratchPath);
  const argv = [
    DARWIN_DOCKER_DESKTOP_CLI,
    "run",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--read-only",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    `${identity.uid}:${identity.gid}`,
    "--memory",
    DARWIN_DOCKER_DESKTOP_RESOURCE_LIMITS.memory,
    "--memory-swap",
    DARWIN_DOCKER_DESKTOP_RESOURCE_LIMITS.memorySwap,
    "--cpus",
    DARWIN_DOCKER_DESKTOP_RESOURCE_LIMITS.cpus,
    "--pids-limit",
    DARWIN_DOCKER_DESKTOP_RESOURCE_LIMITS.pidsLimit,
    "--tmpfs",
    DARWIN_DOCKER_DESKTOP_RESOURCE_LIMITS.tmpfsTmp,
    "--mount",
    bindMount(worktreePath, DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT, true),
    "--mount",
    bindMount(scratchPath, DARWIN_DOCKER_DESKTOP_SCRATCH_ROOT, false),
    "--workdir",
    DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT,
    ...DARWIN_DOCKER_DESKTOP_CONTAINER_ENV.flatMap((value) => ["-e", value]),
    DARWIN_DOCKER_DESKTOP_IMAGE,
  ];
  assertDarwinDockerDesktopIsolationArgv(argv, host);
  return argv;
}

export function bindMount(source: string, target: string, readonly: boolean): string {
  const parts = [`type=bind`, `source=${resolve(source)}`, `target=${target}`];
  if (readonly) parts.push("readonly");
  return parts.join(",");
}

/**
 * Proves host sentinels are unreadable, the candidate is unwritable, scratch is
 * writable, and external connect fails. Unlike the Bubblewrap probe, a loopback
 * listen is not a failure here.
 */
export function darwinDockerDesktopProbeScript(): string {
  return [
    "const fs=require('node:fs'),net=require('node:net');",
    "let ok=true;",
    "const denied=process.argv.slice(1,-2);",
    "for(const p of denied){try{fs.readFileSync(p);ok=false}catch{}}",
    "try{fs.writeFileSync(process.argv.at(-2),'x');ok=false}catch{}",
    "try{fs.writeFileSync(process.argv.at(-1),'x')}catch{ok=false}",
    "const c=net.connect({host:'1.1.1.1',port:443});",
    "c.setTimeout(800);",
    "c.on('connect',()=>{c.destroy();process.exit(1)});",
    "c.on('timeout',()=>{c.destroy();process.exit(ok?0:1)});",
    "c.on('error',()=>process.exit(ok?0:1));",
  ].join("");
}

export function assertDarwinDockerDesktopIsolationArgv(
  argv: readonly string[],
  host: DarwinDockerDesktopIsolationHost,
): void {
  const worktreePath = resolve(host.worktreePath);
  const scratchPath = resolve(host.scratchPath);
  const deniedRoots = [...new Set((host.deniedReadRoots ?? []).map((path) => resolve(path)))];
  const imageIndex = argv.indexOf(DARWIN_DOCKER_DESKTOP_IMAGE);
  if (imageIndex < 0) failValidationBackend("policy-mismatch");
  // Docker options end at the image. Tokens after it belong to the repository
  // command, which may legitimately use flags such as unittest's -v.
  const dockerArgv = argv.slice(0, imageIndex);
  const joined = dockerArgv.join("\0");
  if (argv[0] !== DARWIN_DOCKER_DESKTOP_CLI) failValidationBackend("policy-mismatch");
  if (dockerArgv.includes("--privileged")) failValidationBackend("policy-mismatch");
  if (dockerArgv.includes("--add-host")) failValidationBackend("policy-mismatch");
  if (dockerArgv.includes("-v") || dockerArgv.includes("--volume"))
    failValidationBackend("policy-mismatch");
  if (/\bdocker\.sock\b/u.test(joined) || joined.includes("/run/docker.sock")) {
    failValidationBackend("policy-mismatch");
  }
  if (!hasFlagValue(dockerArgv, "--network", "none")) failValidationBackend("policy-mismatch");
  if (hasFlagValue(dockerArgv, "--network", "host")) failValidationBackend("policy-mismatch");
  if (hasFlagValue(dockerArgv, "--pid", "host")) failValidationBackend("policy-mismatch");
  if (!dockerArgv.includes("--read-only")) failValidationBackend("policy-mismatch");
  if (!dockerArgv.includes("--rm") || !dockerArgv.includes("--init"))
    failValidationBackend("policy-mismatch");
  if (!hasFlagValue(dockerArgv, "--pull", "never")) failValidationBackend("policy-mismatch");
  if (!hasFlagValue(dockerArgv, "--cap-drop", "ALL")) failValidationBackend("policy-mismatch");
  if (!hasFlagValue(dockerArgv, "--memory", DARWIN_DOCKER_DESKTOP_RESOURCE_LIMITS.memory)) {
    failValidationBackend("policy-mismatch");
  }
  if (!hasFlagValue(dockerArgv, "--cpus", DARWIN_DOCKER_DESKTOP_RESOURCE_LIMITS.cpus)) {
    failValidationBackend("policy-mismatch");
  }
  if (!hasFlagValue(dockerArgv, "--pids-limit", DARWIN_DOCKER_DESKTOP_RESOURCE_LIMITS.pidsLimit)) {
    failValidationBackend("policy-mismatch");
  }
  if (!argv[imageIndex]?.includes(DARWIN_DOCKER_DESKTOP_IMAGE_DIGEST)) {
    failValidationBackend("policy-mismatch");
  }

  const mounts = collectFlagValues(dockerArgv, "--mount");
  const worktreeMount = mounts.find((mount) => mountSource(mount) === worktreePath);
  const scratchMount = mounts.find((mount) => mountSource(mount) === scratchPath);
  if (!worktreeMount || !mountHas(worktreeMount, "readonly"))
    failValidationBackend("policy-mismatch");
  if (mountTarget(worktreeMount) !== DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT) {
    failValidationBackend("policy-mismatch");
  }
  if (!scratchMount || mountHas(scratchMount, "readonly")) failValidationBackend("policy-mismatch");
  if (mountTarget(scratchMount) !== DARWIN_DOCKER_DESKTOP_SCRATCH_ROOT) {
    failValidationBackend("policy-mismatch");
  }

  const allowedSources = new Set([worktreePath, scratchPath]);
  for (const mount of mounts) {
    const source = mountSource(mount);
    if (!source || !allowedSources.has(source)) failValidationBackend("policy-mismatch");
    if (deniedRoots.some((root) => source === root || source.startsWith(`${root}/`))) {
      failValidationBackend("policy-mismatch");
    }
  }

  const home = resolve(homedir());
  if (!allowedSources.has(home)) {
    for (const mount of mounts) {
      if (mountSource(mount) === home) failValidationBackend("policy-mismatch");
    }
  }

  for (const value of collectFlagValues(dockerArgv, "-e")) {
    const key = value.split("=", 1)[0] ?? "";
    if (CREDENTIAL_ENV_PATTERN.test(key)) failValidationBackend("policy-mismatch");
  }
}

function hasFlagValue(argv: readonly string[], flag: string, value: string): boolean {
  return collectFlagValues(argv, flag).includes(value);
}

function collectFlagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1] !== undefined) values.push(argv[index + 1]!);
  }
  return values;
}

function mountSource(spec: string): string | undefined {
  const match = /(?:^|,)source=([^,]+)/u.exec(spec);
  return match?.[1] === undefined ? undefined : resolve(match[1]);
}

function mountTarget(spec: string): string | undefined {
  const match = /(?:^|,)target=([^,]+)/u.exec(spec);
  return match?.[1];
}

function mountHas(spec: string, token: string): boolean {
  return spec.split(",").includes(token);
}
