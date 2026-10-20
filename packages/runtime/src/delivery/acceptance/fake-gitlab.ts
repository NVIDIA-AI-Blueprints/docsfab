// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DeliveryAcceptanceChainEvidencePaths } from "../acceptance.js";
import type { DeliveryAcceptanceRunBindingV1 } from "../acceptance-manifest.js";
import type { LocalUserPublicationPlan } from "../contracts.js";
import type {
  GitLabPublisherCommandResult,
  GitLabPublisherCommandRunner,
} from "../gitlab-adapter.js";
import { command } from "./process.js";
import { parseAcceptanceJson } from "./record-codec.js";

const PROJECT_ID = 42;

const PROJECT_PATH = "group/docs";

const PROJECT_HOST = "gitlab.example.test";

interface OfflineFixture {
  root: string;
  source: string;
  bareRemote: string;
  stateDirectory: string;
  deliveryRoot: string;
  receiptRoot: string;
  patchPath: string;
  recordPath: string;
  fakeGitLabStatePath: string;
  sourceRevision: string;
  patchSha256: string;
  patchByteLength: number;
  patchLineCount: number;
  recordSha256: string;
  governedRuns: {
    readiness: DeliveryAcceptanceRunBindingV1;
    audit: DeliveryAcceptanceRunBindingV1;
    write: DeliveryAcceptanceRunBindingV1;
  };
  chainEvidencePaths: DeliveryAcceptanceChainEvidencePaths;
  authorization: {
    sha256: string;
    digest: string;
    reviewerId: string;
    policyDigest: string;
    decidedAt: string;
    expiresAt: string;
    gapId: string;
    evidenceSha256: string;
    successCriterionSha256: string;
    approvedOutcomeSha256: string;
    intendedPaths: string[];
  };
}

interface FakeGitLabState {
  schemaVersion: 1;
  createCount: number;
  mergeRequest?: Record<string, unknown>;
  targetRevision?: string;
}

interface AttemptMode {
  denyPush?: boolean;
  protectionDrift?: boolean;
  authenticationUnavailable?: boolean;
  crashAfter?: "commit" | "push" | "merge-request";
}

class OfflineFakeGitLab implements GitLabPublisherCommandRunner {
  public constructor(
    private readonly fixture: OfflineFixture,
    private readonly plan?: LocalUserPublicationPlan,
    private readonly mode: AttemptMode = {},
  ) {}

  public run(
    _commandName: "glab",
    args: readonly string[],
    _cwd: string,
    options: {
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<GitLabPublisherCommandResult> {
    const allowedEnvironment = new Set([
      "LC_ALL",
      "LANG",
      "NO_COLOR",
      "PAGER",
      "GLAB_PAGER",
      "GIT_PAGER",
      "GIT_TERMINAL_PROMPT",
    ]);
    if (
      Object.keys(options.env).some((key) => !allowedEnvironment.has(key)) ||
      options.env.GLAB_TOKEN !== undefined ||
      options.env.GITLAB_TOKEN !== undefined ||
      options.timeoutMs !== 30_000 ||
      options.maxOutputBytes !== 1_000_000
    ) {
      throw new Error(
        "Offline fake GitLab received ambient credentials or an unbounded command policy.",
      );
    }
    return this.execute(args);
  }

  public async execute(args: readonly string[]): Promise<GitLabPublisherCommandResult> {
    const key = args.join(" ");
    if (key === "version") return output("glab 1.0.0\n");
    if (key === `auth status --hostname ${PROJECT_HOST}`) {
      return this.mode.authenticationUnavailable ? failure() : output("");
    }
    if (key === `api --hostname ${PROJECT_HOST} user`) return json({ username: "maintainer" });
    if (args[0] === "api" && args[1] === "--hostname" && args[3] === "graphql") {
      const fullPath = args
        .find((value) => value.startsWith("fullPath="))
        ?.slice("fullPath=".length);
      if (fullPath !== PROJECT_PATH) return failure();
      return json({
        data: {
          project: {
            id: `gid://gitlab/Project/${PROJECT_ID}`,
            fullPath: PROJECT_PATH,
          },
        },
      });
    }
    if (
      key === `api --hostname ${PROJECT_HOST} projects/${encodeURIComponent(PROJECT_PATH)}` ||
      key === `api --hostname ${PROJECT_HOST} projects/${PROJECT_ID}`
    ) {
      return json({
        id: PROJECT_ID,
        path_with_namespace: PROJECT_PATH,
        default_branch: "main",
        permissions: {
          project_access: { access_level: 30 },
          group_access: null,
        },
      });
    }
    if (key === `api --hostname ${PROJECT_HOST} projects/${PROJECT_ID}/repository/branches/main`) {
      const state = await loadFakeGitLabState(this.fixture.fakeGitLabStatePath);
      return json({
        name: "main",
        protected: this.mode.protectionDrift ? false : true,
        commit: { id: state.targetRevision ?? this.fixture.sourceRevision },
      });
    }
    if (
      key ===
        `api --hostname ${PROJECT_HOST} projects/${PROJECT_ID}/protected_branches?per_page=100&page=1` ||
      key ===
        `api --hostname ${PROJECT_HOST} projects/${PROJECT_ID}/protected_branches?per_page=100`
    ) {
      return json(
        this.mode.protectionDrift && this.plan
          ? [{ name: this.plan.proposedSourceBranch }]
          : [{ name: "main" }],
      );
    }
    if (
      key ===
      `api --hostname ${PROJECT_HOST} projects/${PROJECT_ID}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(this.plan?.proposedSourceBranch ?? "")}&per_page=100&page=1`
    ) {
      if (!this.plan) return failure();
      const state = await loadFakeGitLabState(this.fixture.fakeGitLabStatePath);
      return json(state.mergeRequest ? [state.mergeRequest] : []);
    }
    if (
      args[0] === "api" &&
      args[1] === "--hostname" &&
      args[2] === PROJECT_HOST &&
      args[3] === "--method" &&
      args[4] === "POST" &&
      args[5] === `projects/${PROJECT_ID}/merge_requests`
    ) {
      if (!this.plan) return failure();
      if ((args.length - 6) % 2 !== 0) return failure();
      const fields: Record<string, string> = {};
      for (let index = 6; index < args.length; index += 2) {
        if (args[index] !== "--field") return failure();
        const field = args[index + 1] ?? "";
        const separator = field.indexOf("=");
        if (separator <= 0 || fields[field.slice(0, separator)] !== undefined) return failure();
        fields[field.slice(0, separator)] = field.slice(separator + 1);
      }
      if (
        Object.keys(fields).sort().join(",") !==
          "description,remove_source_branch,source_branch,squash,target_branch,title" ||
        fields.source_branch !== this.plan.proposedSourceBranch ||
        fields.target_branch !== this.plan.targetBranch.name ||
        fields.remove_source_branch !== "false" ||
        fields.squash !== "false" ||
        !fields.title?.startsWith("Draft: [DocsFab Run] ") ||
        !fields.description?.includes("<!-- docsfab-publication-provenance:v1 ") ||
        !fields.description.includes(`plan=${this.plan.sha256} `) ||
        !fields.description.includes(`source=${this.plan.baseRevision} `) ||
        !fields.description.includes(`patch=${this.plan.patch.sha256} `)
      ) {
        return failure();
      }
      const headRevision = await bareRevision(
        this.fixture.bareRemote,
        this.plan.proposedSourceBranch,
      );
      if (!headRevision) return failure();
      const state = await loadFakeGitLabState(this.fixture.fakeGitLabStatePath);
      if (state.mergeRequest) return json(state.mergeRequest);
      const mergeRequest = {
        iid: 17,
        state: "opened",
        draft: true,
        title: fields.title,
        description: fields.description,
        source_branch: fields.source_branch,
        target_branch: fields.target_branch,
        sha: headRevision,
        source_project_id: PROJECT_ID,
        target_project_id: PROJECT_ID,
      };
      await saveFakeGitLabState(this.fixture.fakeGitLabStatePath, {
        schemaVersion: 1,
        createCount: state.createCount + 1,
        mergeRequest,
        ...(state.targetRevision === undefined ? {} : { targetRevision: state.targetRevision }),
      });
      return json(mergeRequest);
    }
    return failure();
  }
}

async function loadFakeGitLabState(path: string): Promise<FakeGitLabState> {
  const value = parseAcceptanceJson(
    await readFile(path),
    1024 * 1024,
    "fake GitLab state",
  ) as unknown as FakeGitLabState;
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.createCount) ||
    value.createCount < 0 ||
    (value.targetRevision !== undefined &&
      (typeof value.targetRevision !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.targetRevision)))
  ) {
    throw new Error("Invalid fake glab state.");
  }
  return value;
}

async function saveFakeGitLabState(path: string, value: FakeGitLabState): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rm(path, { force: true });
  await writeFile(path, await readFile(temp), { mode: 0o600, flag: "wx" });
  await rm(temp, { force: true });
}

async function bareRevision(bare: string, branch: string): Promise<string | undefined> {
  const result = await command(
    "git",
    ["--git-dir", bare, "rev-parse", `refs/heads/${branch}`],
    bare,
    process.env,
  );
  return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : undefined;
}

function output(value: string): GitLabPublisherCommandResult {
  return { exitCode: 0, stdout: Buffer.from(value) };
}

function json(value: unknown): GitLabPublisherCommandResult {
  return output(`${JSON.stringify(value)}\n`);
}

function failure(): GitLabPublisherCommandResult {
  return { exitCode: 1, stdout: Buffer.alloc(0) };
}

export {
  PROJECT_HOST,
  PROJECT_PATH,
  type OfflineFixture,
  type AttemptMode,
  OfflineFakeGitLab,
  loadFakeGitLabState,
  saveFakeGitLabState,
  bareRevision,
};
