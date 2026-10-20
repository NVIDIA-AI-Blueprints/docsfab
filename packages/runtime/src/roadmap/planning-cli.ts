// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify, types as utilTypes } from "node:util";

import { GitLabRoadmapReader, type RoadmapIssueReader } from "./gitlab-readonly.js";
import {
  planRoadmap,
  decodeRoadmapPlanningInput,
  renderRoadmapPlanningArtifact,
  serializeRoadmapPlanningArtifact,
  type RoadmapPlanningArtifact,
  type RoadmapReleaseBoundaryAuthority,
} from "./planning.js";
import { roadmapCanonicalJson, roadmapDigest } from "./contracts/decode.js";
import {
  internalCreateRoadmapPlanningHostAuthority,
  internalIssueRoadmapPlanningSourceCapability,
} from "./planning-authority-internal.js";

const execute = promisify(execFile);

export interface RoadmapPlanCliArguments {
  mode: "release" | "health" | "sweep";
  inputPath: string;
  repositoryPath: string;
  revision: string;
  since?: string;
  releaseRef?: string;
  scope?: string;
  sweepLedgerPath?: string;
  proposalCap?: number;
  gitlabUrl?: string;
  json: boolean;
}

export interface RoadmapPlanCliDependencies {
  issueReader?: RoadmapIssueReader;
  inspectRepository?: (
    path: string,
    revision: string,
  ) => Promise<{ revision: string; contentDigest: string }>;
  inspectReleaseBoundary?: (
    path: string,
    from: string,
    to: string,
    project: { provider: string; host: string; fullPath: string; projectId: number },
  ) => Promise<RoadmapReleaseBoundaryAuthority>;
  readJson?: (path: string) => Promise<unknown>;
  log?: (message: string) => void;
  environment?: NodeJS.ProcessEnv;
  /** Host-owned and independent of planning input. */
  trustedProject?: { provider: string; host: string; fullPath: string; projectId: number };
  /** Exact immutable reviewed source digest from host configuration. */
  trustedSourceDigest?: string;
}

export function parseRoadmapPlanCliArguments(
  args: string[],
  cwd = process.cwd(),
): RoadmapPlanCliArguments {
  const flags = new Set(["--json"]);
  const values = new Set([
    "--mode",
    "--input",
    "--repo",
    "--revision",
    "--since",
    "--release-ref",
    "--scope",
    "--sweep",
    "--limit",
    "--gitlab-url",
  ]);
  const seenFlags = new Set<string>();
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (flags.has(argument)) {
      if (seenFlags.has(argument))
        throw new Error(`Roadmap planning option ${argument} is duplicated.`);
      seenFlags.add(argument);
      continue;
    }
    if (!values.has(argument)) throw new Error(`Unknown roadmap planning option ${argument}.`);
    if (parsed.has(argument)) throw new Error(`Roadmap planning option ${argument} is duplicated.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    parsed.set(argument, value);
    index += 1;
  }
  const inputPath = parsed.get("--input");
  if (!inputPath) throw new Error("roadmap-plan requires --input <authenticated-json>.");
  const explicitMode = parsed.get("--mode");
  const sweepLedgerPath = parsed.get("--sweep");
  const mode = sweepLedgerPath ? "sweep" : explicitMode;
  if (mode !== "release" && mode !== "health" && mode !== "sweep")
    throw new Error("roadmap-plan requires --mode release|health or --sweep <ledger>.");
  if (sweepLedgerPath && explicitMode)
    throw new Error("--sweep and --mode are mutually exclusive.");
  const since = parsed.get("--since");
  const releaseRef = parsed.get("--release-ref");
  const scope = parsed.get("--scope");
  if (mode === "release" && !since)
    throw new Error("release roadmap planning requires --since <tag-or-revision>.");
  if (mode !== "release" && (since || releaseRef))
    throw new Error("--since and --release-ref are release-only.");
  if (mode !== "health" && scope) throw new Error("--scope is health-only.");
  const capText = parsed.get("--limit");
  const proposalCap = capText === undefined ? undefined : Number(capText);
  if (
    proposalCap !== undefined &&
    (!Number.isSafeInteger(proposalCap) || proposalCap < 1 || proposalCap > 100)
  ) {
    throw new Error("--limit must be an integer between 1 and 100.");
  }
  const repositoryPath = resolve(cwd, parsed.get("--repo") ?? ".");
  return {
    mode,
    inputPath: resolve(cwd, inputPath),
    repositoryPath,
    revision: parsed.get("--revision") ?? "HEAD",
    ...(since ? { since } : {}),
    ...(releaseRef ? { releaseRef } : {}),
    ...(scope ? { scope: safeRelativePath(scope, "--scope") } : {}),
    ...(sweepLedgerPath ? { sweepLedgerPath: resolve(cwd, sweepLedgerPath) } : {}),
    ...(proposalCap === undefined ? {} : { proposalCap }),
    ...(parsed.get("--gitlab-url") ? { gitlabUrl: parsed.get("--gitlab-url") } : {}),
    json: seenFlags.has("--json"),
  };
}

export async function runRoadmapPlanCli(
  args: string[],
  dependencies: RoadmapPlanCliDependencies = {},
): Promise<RoadmapPlanningArtifact> {
  const parsed = parseRoadmapPlanCliArguments(args);
  const readJson = dependencies.readJson ?? readStrictJson;
  const inspect = dependencies.inspectRepository ?? inspectGitRepository;
  const [rawInput, repository, sweepLedger] = await Promise.all([
    readJson(parsed.inputPath),
    inspect(parsed.repositoryPath, parsed.revision),
    parsed.sweepLedgerPath ? readJson(parsed.sweepLedgerPath) : Promise.resolve(undefined),
  ]);
  const raw = inertCliObject(rawInput, "Roadmap planning input");
  const input = {
    ...raw,
    ...(parsed.sweepLedgerPath ? { mode: "sweep", baseLedger: sweepLedger } : {}),
  } as Record<string, unknown>;
  const decoded = decodeRoadmapPlanningInput(input);
  if (parsed.proposalCap !== undefined && decoded.proposalCap !== parsed.proposalCap)
    throw new Error("Authenticated planning input does not bind the selected proposal limit.");
  if (decoded.mode !== parsed.mode)
    throw new Error("CLI planning mode does not match the authenticated input mode.");
  if (
    decoded.repository.revision !== repository.revision ||
    decoded.repository.contentDigest !== repository.contentDigest
  ) {
    throw new Error("Authenticated planning input is stale for the selected repository revision.");
  }
  if (parsed.mode === "release") {
    const fromRevision = await inspect(parsed.repositoryPath, parsed.since!);
    if (
      decoded.mode !== "release" ||
      decoded.fromRevision !== fromRevision.revision ||
      decoded.toRevision !== repository.revision
    ) {
      throw new Error("Release planning input does not bind the exact selected boundary.");
    }
    if ((decoded.releaseRef ?? undefined) !== parsed.releaseRef) {
      throw new Error("Release planning input does not bind the selected release ref.");
    }
    const actualBoundary = await (dependencies.inspectReleaseBoundary ?? inspectGitReleaseBoundary)(
      parsed.repositoryPath,
      fromRevision.revision,
      repository.revision,
      decoded.project,
    );
    if (roadmapCanonicalJson(actualBoundary) !== roadmapCanonicalJson(decoded.releaseBoundary))
      throw new Error("Release planning input does not account for the exact Git boundary.");
  }
  if (decoded.mode === "health" && (decoded.scope ?? undefined) !== parsed.scope) {
    throw new Error("Health planning input does not bind the selected scope.");
  }
  const environment = dependencies.environment ?? process.env;
  const trustedProject = dependencies.trustedProject ?? trustedProjectFromEnvironment(environment);
  if (roadmapCanonicalJson(decoded.project) !== roadmapCanonicalJson(trustedProject))
    throw new Error("Planning project does not match the host-owned trusted project authority.");
  const trustedSourceDigest =
    dependencies.trustedSourceDigest ?? environment.DOCSFAB_ROADMAP_SOURCE_SHA256;
  if (!trustedSourceDigest) throw new Error("Host-owned roadmap source authority is required.");
  const hostAuthority = internalCreateRoadmapPlanningHostAuthority(trustedSourceDigest);
  const sourceCapability = internalIssueRoadmapPlanningSourceCapability(
    hostAuthority,
    roadmapDigest({ source: decoded }),
  );
  const reader =
    dependencies.issueReader ??
    new GitLabRoadmapReader({
      project: trustedProject,
      ...(parsed.gitlabUrl ? { baseUrl: parsed.gitlabUrl } : {}),
      ...((environment.GITLAB_TOKEN ?? environment.PRIVATE_TOKEN)
        ? { token: environment.GITLAB_TOKEN ?? environment.PRIVATE_TOKEN }
        : {}),
    });
  const tracker = await reader.observe(trustedProject);
  const artifact = planRoadmap(decoded, tracker, sourceCapability);
  const log = dependencies.log ?? console.log;
  log(
    parsed.json
      ? serializeRoadmapPlanningArtifact(artifact, sourceCapability).trimEnd()
      : renderRoadmapPlanningArtifact(artifact, sourceCapability),
  );
  return artifact;
}

export async function inspectGitReleaseBoundary(
  repositoryPath: string,
  from: string,
  to: string,
  project: { provider: string; host: string; fullPath: string; projectId: number },
): Promise<RoadmapReleaseBoundaryAuthority> {
  const [fromRepository, toRepository] = await Promise.all([
    inspectGitRepository(repositoryPath, from),
    inspectGitRepository(repositoryPath, to),
  ]);
  const common = { cwd: repositoryPath, encoding: "buffer" as const, maxBuffer: 64 * 1024 * 1024 };
  const diff = await execute(
    "git",
    [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      fromRepository.revision,
      toRepository.revision,
      "--",
    ],
    common,
  );
  const bytes = Buffer.from(diff.stdout);
  const parts = bytes.toString("utf8").split("\0");
  if (parts.at(-1) !== "") throw new Error("Git release boundary is not NUL terminated.");
  parts.pop();
  const changes: RoadmapReleaseBoundaryAuthority["changes"] = [];
  for (let index = 0; index < parts.length; ) {
    const rawStatus = parts[index++]!;
    const code = rawStatus[0];
    if (!code || !["A", "M", "D", "R"].includes(code))
      throw new Error("Git release boundary contains an unsupported change status.");
    const previousPath = code === "R" ? parts[index++] : undefined;
    const path = parts[index++];
    if (!path || (code === "R" && !previousPath))
      throw new Error("Git release boundary is malformed.");
    const status =
      code === "A"
        ? ("added" as const)
        : code === "M"
          ? ("modified" as const)
          : code === "D"
            ? ("deleted" as const)
            : ("renamed" as const);
    const material = { status, path, ...(previousPath === undefined ? {} : { previousPath }) };
    changes.push({ ...material, evidenceDigest: roadmapDigest(material) });
  }
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const candidate: RoadmapReleaseBoundaryAuthority = {
    kind: "git-release-boundary",
    fromRevision: fromRepository.revision,
    toRevision: toRepository.revision,
    fromTreeDigest: fromRepository.contentDigest,
    toTreeDigest: toRepository.contentDigest,
    diffDigest: createHash("sha256").update(bytes).digest("hex"),
    projectIdentityDigest: roadmapDigest(project),
    changes,
    digest: "0".repeat(64),
  };
  candidate.digest = roadmapDigest(candidate);
  return candidate;
}

export async function inspectGitRepository(
  repositoryPath: string,
  requestedRevision: string,
): Promise<{ revision: string; contentDigest: string }> {
  const common = { cwd: repositoryPath, encoding: "buffer" as const, maxBuffer: 64 * 1024 * 1024 };
  const revisionResult = await execute(
    "git",
    ["rev-parse", "--verify", `${requestedRevision}^{commit}`],
    common,
  );
  const revision = Buffer.from(revisionResult.stdout).toString("utf8").trim();
  if (!/^[a-f0-9]{40}$/u.test(revision))
    throw new Error("Selected repository revision is not a full commit ID.");
  const tree = await execute("git", ["ls-tree", "-r", "--full-tree", "-z", revision], common);
  return {
    revision,
    contentDigest: createHash("sha256").update(Buffer.from(tree.stdout)).digest("hex"),
  };
}

async function readStrictJson(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length < 2 || bytes.length > 16 * 1024 * 1024 || bytes.includes(0))
    throw new Error("Roadmap planning JSON has an invalid size or encoding.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function safeRelativePath(value: string, option: string): string {
  if (
    !value ||
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${option} requires a safe repository-relative path.`);
  }
  return value;
}

function inertCliObject(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} must be an inert object.`);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} must be an inert object.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      throw new Error(`${label} must be an inert object.`);
    result[key] = descriptor.value;
  }
  return result;
}

function trustedProjectFromEnvironment(environment: NodeJS.ProcessEnv): {
  provider: string;
  host: string;
  fullPath: string;
  projectId: number;
} {
  const host = environment.DOCSFAB_ROADMAP_GITLAB_HOST;
  const fullPath = environment.DOCSFAB_ROADMAP_GITLAB_FULL_PATH;
  const projectId = Number(environment.DOCSFAB_ROADMAP_GITLAB_PROJECT_ID);
  if (!host || !fullPath || !Number.isSafeInteger(projectId) || projectId < 1)
    throw new Error("Host-owned trusted GitLab project configuration is required.");
  return { provider: "gitlab", host, fullPath, projectId };
}
