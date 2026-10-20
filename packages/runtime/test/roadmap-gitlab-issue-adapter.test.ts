// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  LocalUserGitLabIssueAdapter,
  roadmapDigest,
  type GitLabIssueCommandResult,
  type GitLabIssueCommandRunner,
  type IssueLifecycleMutationContext,
  type RoadmapMutationOperationV2,
} from "../src/roadmap/index.js";

const PROJECT = {
  provider: "gitlab",
  host: "gitlab.example.com",
  fullPath: "group/docsfab",
  projectId: 42,
};
const TIME = "2026-08-05T00:00:00.000Z";
const OPERATOR = {
  operatorIdentityDigest: roadmapDigest({
    provider: "gitlab",
    host: PROJECT.host,
    username: "maintainer",
  }),
  expectedAccessLevel: 40,
};

describe("local-user GitLab issue adapter", () => {
  it("preflights the exact operator and project without forwarding token environment", async () => {
    const runner = new FixtureRunner((args) => {
      if (args[0] === "auth") return {};
      if (args.at(-1) === "user") return { username: "maintainer" };
      return {
        id: 42,
        path_with_namespace: "group/docsfab",
        default_branch: "main",
        permissions: { project_access: { access_level: 40 }, group_access: null },
      };
    });
    const adapter = new LocalUserGitLabIssueAdapter(runner, {
      PATH: "/bin",
      HOME: "/tmp/operator",
      GITLAB_TOKEN: "glpat-secret",
      GLAB_TOKEN: "glpat-other",
      GLAB_HOST: "wrong.example.com",
    });
    const result = await adapter.preflight(PROJECT);
    expect(result).toMatchObject({
      identity: { username: "maintainer", host: "gitlab.example.com" },
      project: { accessLevel: 40, defaultBranch: "main" },
    });
    expect(
      runner.calls.every(
        (call) =>
          call.env.GITLAB_TOKEN === undefined &&
          call.env.GLAB_TOKEN === undefined &&
          call.env.GLAB_HOST === undefined,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("glpat-secret");
  });

  it("normalizes issue responses and never exposes unrestricted response bodies", async () => {
    const runner = new FixtureRunner(() => ({
      iid: 7,
      title: "Title",
      description: "PRIVATE-TOKEN: glpat-secret",
      state: "opened",
      labels: ["docs"],
      milestone: null,
      updated_at: TIME,
    }));
    const issue = await new LocalUserGitLabIssueAdapter(runner).getIssue(PROJECT, 7);
    expect(issue).toMatchObject({ iid: 7, state: "opened", labels: ["docs"], updatedAt: TIME });
    expect(JSON.stringify(issue)).not.toContain("PRIVATE-TOKEN");
    expect(JSON.stringify(issue)).not.toContain("glpat-secret");
  });

  it("reconciles an existing parent task-list marker without adding a duplicate", async () => {
    const operation = fakeOperation("operation:parent", "link");
    const runner = new FixtureRunner((args) =>
      args.some((item) => item.includes("/notes?"))
        ? [
            {
              id: 91,
              body: `<!-- docsfab-roadmap:v2 operation=${operation.key} idempotency=${operation.idempotencyKey} proof=${"f".repeat(64)} -->\n- [ ] #8`,
              created_at: TIME,
              updated_at: TIME,
            },
          ]
        : [],
    );
    const adapter = new LocalUserGitLabIssueAdapter(runner);
    const result = await adapter.reconcile({
      project: PROJECT,
      operation,
      material: { operationKey: operation.key, action: "link-parent-task" },
      targetIssue: normalizedIssue(7),
      relatedIssue: normalizedIssue(8),
      operationProofDigest: "f".repeat(64),
      ...OPERATOR,
      assertAuthorized() {},
    });
    expect(result).toMatchObject({
      disposition: "found",
      effect: { kind: "link", subjectTargetKey: "issue:7", relatedTargetKey: "issue:8" },
    });
    expect(runner.calls.some((call) => call.args.includes("POST"))).toBe(false);
  });

  it("checks explicit authorization before every mutation and exposes only sanitized failures", async () => {
    const runner = new FixtureRunner(() => {
      throw new Error("must not execute");
    });
    const adapter = new LocalUserGitLabIssueAdapter(runner);
    const operation = fakeOperation("operation:close", "closure");
    const context: IssueLifecycleMutationContext = {
      project: PROJECT,
      operation,
      material: { operationKey: operation.key, action: "close" },
      targetIssue: normalizedIssue(7),
      ...OPERATOR,
      assertAuthorized() {
        throw new Error("authorization denied glpat-secret");
      },
    };
    await expect(adapter.mutate(context)).rejects.toThrow("authorization denied");
    expect(runner.calls).toEqual([]);
  });

  it("treats a lost mutation response as ambiguous so reconciliation is mandatory", async () => {
    const runner: GitLabIssueCommandRunner = {
      async run(_command, args) {
        if (args.includes("PUT"))
          return { exitCode: 1, stdout: Buffer.alloc(0), failure: "external" };
        const value =
          args[0] === "auth"
            ? {}
            : args.at(-1) === "user"
              ? { username: "maintainer" }
              : args.at(-1) === "projects/42"
                ? rawProject()
                : {
                    iid: 7,
                    title: "Title",
                    description: "body",
                    state: "opened",
                    labels: ["docs"],
                    milestone: null,
                    updated_at: TIME,
                  };
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify(value)), failure: "none" };
      },
    };
    const adapter = new LocalUserGitLabIssueAdapter(runner);
    const operation = fakeOperation("operation:close", "closure");
    const targetIssue = await adapter.getIssue(PROJECT, 7);
    await expect(
      adapter.mutate({
        project: PROJECT,
        operation,
        material: { operationKey: operation.key, action: "close" },
        targetIssue,
        ...OPERATOR,
        assertAuthorized() {},
      }),
    ).rejects.toMatchObject({ code: "ambiguous-effect" });
  });

  it("keeps every supported operation behind the fixed adapter and an explicit authorization callback", async () => {
    const runner = new MutationRunner();
    const adapter = new LocalUserGitLabIssueAdapter(runner);
    const targetIssue = await adapter.getIssue(PROJECT, 7);
    const relatedIssue = await adapter.getIssue(PROJECT, 8);
    const targetMilestone = await adapter.getMilestone(PROJECT, 3);
    const cases = [
      ["create-issue", { title: "@/tmp/title", description: "true %{placeholder}", labels: [] }],
      ["create-saga", { title: "Saga", description: "Body", labels: ["docs"] }],
      ["create-milestone", { title: "Wave", description: "Body", dueDate: "2026-08-31" }],
      ["update-title", { title: "false" }],
      ["update-description", { description: "@/etc/passwd" }],
      ["add-labels", { labels: ["docs"] }],
      ["remove-labels", { labels: ["docs"] }],
      ["assign-milestone", { milestoneIid: 3 }],
      ["link-related", {}],
      ["link-blocks", {}],
      ["link-parent-task", {}],
      ["comment", { body: "@/tmp/comment %{value}" }],
      ["close", {}],
      ["reopen", {}],
    ] as const;
    let authorizationChecks = 0;
    for (const [action, fields] of cases) {
      const kind =
        action === "create-saga"
          ? "saga"
          : action === "create-issue"
            ? "issue"
            : action === "create-milestone"
              ? "milestone"
              : action === "comment"
                ? "comment"
                : action.startsWith("link-")
                  ? "link"
                  : action === "close" || action === "reopen"
                    ? "closure"
                    : "update";
      const operation = fakeBroadOperation(`operation:${action}`, kind);
      const effect = await adapter.mutate({
        project: PROJECT,
        operation,
        material: {
          operationKey: operation.key,
          action,
          ...fields,
        } as IssueLifecycleMutationContext["material"],
        ...(action.startsWith("create-") ? {} : { targetIssue }),
        ...(action.startsWith("link-") ? { relatedIssue } : {}),
        ...(action === "assign-milestone" ? { targetMilestone } : {}),
        ...(action === "create-issue" || action === "create-saga" || action === "create-milestone"
          ? { operationProofDigest: "f".repeat(64) }
          : {}),
        ...OPERATOR,
        assertAuthorized() {
          authorizationChecks += 1;
        },
      });
      expect(effect.kind).toBe(
        action === "create-milestone"
          ? "milestone"
          : action === "comment"
            ? "note"
            : action.startsWith("link-")
              ? "link"
              : "issue",
      );
    }
    expect(authorizationChecks).toBe(cases.length * 2);
    expect(runner.mutationCalls).toHaveLength(cases.length);
    expect(
      runner.mutationCalls.every((args) => args[0] === "api" && args.includes("--method")),
    ).toBe(true);
    expect(
      runner.mutationCalls.every(
        (args) => !args.includes("--field") && args.includes("--raw-field"),
      ),
    ).toBe(true);
    const rawArguments = runner.mutationCalls.flat();
    expect(rawArguments).toContain("title=@/tmp/title");
    expect(rawArguments).toContain("title=false");
    expect(rawArguments).toContain("description=@/etc/passwd");
    expect(rawArguments.some((value) => value.startsWith("body=@/tmp/comment %{value}"))).toBe(
      true,
    );
  });

  it("rechecks expiry, operator identity, and access after reads and immediately before PUT", async () => {
    const operation = fakeOperation("operation:close", "closure");
    const expiredRunner = new MutationRunner();
    const expiredAdapter = new LocalUserGitLabIssueAdapter(expiredRunner);
    const targetIssue = await expiredAdapter.getIssue(PROJECT, 7);
    let checks = 0;
    await expect(
      expiredAdapter.mutate({
        project: PROJECT,
        operation,
        material: { operationKey: operation.key, action: "close" },
        targetIssue,
        ...OPERATOR,
        assertAuthorized() {
          checks += 1;
          if (checks === 2) throw new Error("expired");
        },
      }),
    ).rejects.toThrow("expired");
    expect(expiredRunner.mutationCalls).toEqual([]);

    const identityRunner = new MutationRunner();
    const identityAdapter = new LocalUserGitLabIssueAdapter(identityRunner);
    const identityTarget = await identityAdapter.getIssue(PROJECT, 7);
    identityRunner.username = "substituted-operator";
    await expect(
      identityAdapter.mutate({
        project: PROJECT,
        operation,
        material: { operationKey: operation.key, action: "close" },
        targetIssue: identityTarget,
        ...OPERATOR,
        assertAuthorized() {},
      }),
    ).rejects.toMatchObject({ code: "authentication-revoked" });
    expect(identityRunner.mutationCalls).toEqual([]);

    const accessRunner = new MutationRunner();
    const accessAdapter = new LocalUserGitLabIssueAdapter(accessRunner);
    const accessTarget = await accessAdapter.getIssue(PROJECT, 7);
    accessRunner.accessLevel = 30;
    await expect(
      accessAdapter.mutate({
        project: PROJECT,
        operation,
        material: { operationKey: operation.key, action: "close" },
        targetIssue: accessTarget,
        ...OPERATOR,
        assertAuthorized() {},
      }),
    ).rejects.toMatchObject({ code: "authentication-revoked" });
    expect(accessRunner.mutationCalls).toEqual([]);
  });
});

class FixtureRunner implements GitLabIssueCommandRunner {
  public readonly calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  public constructor(private readonly fixture: (args: readonly string[]) => unknown) {}
  public async run(
    _command: "glab",
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ): Promise<GitLabIssueCommandResult> {
    this.calls.push({ args, env: options.env });
    return {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(this.fixture(args))),
      failure: "none",
    };
  }
}

class MutationRunner implements GitLabIssueCommandRunner {
  public readonly mutationCalls: readonly string[][] = [];
  public username = "maintainer";
  public accessLevel = 40;
  public async run(_command: "glab", args: readonly string[]): Promise<GitLabIssueCommandResult> {
    const mutable = this.mutationCalls as string[][];
    const methodIndex = args.indexOf("--method");
    if (methodIndex >= 0) mutable.push([...args]);
    const endpoint = methodIndex >= 0 ? args[methodIndex + 2]! : args.at(-1)!;
    let value: unknown;
    if (args[0] === "auth") value = {};
    else if (methodIndex < 0 && endpoint === "user") value = { username: this.username };
    else if (methodIndex < 0 && endpoint === "projects/42") value = rawProject(this.accessLevel);
    else if (methodIndex < 0 && endpoint.includes("/milestones?")) value = [rawMilestone(3)];
    else if (methodIndex < 0) value = rawIssue(endpoint.endsWith("/8") ? 8 : 7);
    else if (endpoint.endsWith("/milestones"))
      value = {
        id: 103,
        iid: 3,
        title: "Wave",
        description: "Body",
        state: "active",
        created_at: TIME,
        updated_at: TIME,
      };
    else if (endpoint.endsWith("/notes"))
      value = { id: 91, body: "note", created_at: TIME, updated_at: TIME };
    else if (endpoint.endsWith("/links"))
      value = { id: 8, iid: 8, link_type: "relates_to", created_at: TIME, updated_at: TIME };
    else value = rawIssue(endpoint.endsWith("/issues") ? 9 : 7);
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify(value)), failure: "none" };
  }
}

function normalizedIssue(iid: number) {
  const body = {
    iid,
    titleDigest: roadmapDigest({ text: `issue ${iid}` }),
    descriptionDigest: roadmapDigest({ text: "description" }),
    state: "opened" as const,
    labels: ["docs"],
    updatedAt: TIME,
  };
  return { ...body, identityDigest: roadmapDigest({ contract: "fixture-issue", iid }) };
}

function fakeOperation(key: string, kind: "link" | "closure"): RoadmapMutationOperationV2 {
  return {
    key,
    kind,
    findingIds: ["finding:one"],
    dependsOnOperationKeys: [],
    target: { source: "ledger-observation", targetKey: "issue:7" },
    ...(kind === "link"
      ? { relatedTarget: { source: "ledger-observation" as const, targetKey: "issue:8" } }
      : {}),
    preconditions: [],
    proposal: {
      kind,
      intent: kind === "link" ? "link" : "close",
      effectKind: kind === "link" ? "link" : "issue",
    },
    proposalDigest: "a".repeat(64),
    materialDigest: "b".repeat(64),
    materialBytes: 10,
    expectedEffectKind: kind === "link" ? "link" : "issue",
    idempotencyKey: "c".repeat(64),
  };
}

function fakeBroadOperation(
  key: string,
  kind: RoadmapMutationOperationV2["kind"],
): RoadmapMutationOperationV2 {
  const effectKind =
    kind === "milestone"
      ? "milestone"
      : kind === "comment"
        ? "note"
        : kind === "link"
          ? "link"
          : "issue";
  const intent =
    kind === "saga" || kind === "issue" || kind === "milestone"
      ? "create"
      : kind === "comment"
        ? "comment"
        : kind === "link"
          ? "link"
          : kind === "closure"
            ? "close"
            : "update";
  return {
    key,
    kind,
    findingIds: ["finding:one"],
    dependsOnOperationKeys: [],
    target:
      kind === "saga" || kind === "issue" || kind === "milestone"
        ? { source: "project", targetKey: "project:42" }
        : { source: "ledger-observation", targetKey: "issue:7" },
    ...(kind === "link"
      ? { relatedTarget: { source: "ledger-observation" as const, targetKey: "issue:8" } }
      : {}),
    preconditions: [],
    proposal: { kind, intent, effectKind },
    proposalDigest: "a".repeat(64),
    materialDigest: "b".repeat(64),
    materialBytes: 10,
    expectedEffectKind: effectKind,
    idempotencyKey: "c".repeat(64),
  } as RoadmapMutationOperationV2;
}

function rawIssue(iid: number) {
  return {
    iid,
    title: `Issue ${iid}`,
    description: "Body",
    state: "opened",
    labels: ["docs"],
    milestone: null,
    created_at: TIME,
    updated_at: TIME,
  };
}

function rawProject(accessLevel = 40) {
  return {
    id: 42,
    path_with_namespace: "group/docsfab",
    default_branch: "main",
    permissions: { project_access: { access_level: accessLevel }, group_access: null },
  };
}

function rawMilestone(iid: number) {
  return {
    id: 100 + iid,
    iid,
    title: "Wave",
    description: "Body",
    state: "active",
    created_at: TIME,
    updated_at: TIME,
  };
}
