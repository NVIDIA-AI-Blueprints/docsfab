// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  LocalUserGitLabPublisherAdapter,
  GitLabPublisherAdapterError,
  glabEnvironment,
  buildDocsFabPublicationMetadata,
  createCompositionPublicationBinding,
  hasExactDocsFabPublicationMetadata,
  hasExactDocsFabPublicationProvenance,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  type GitLabPublisherCommandResult,
  type GitLabPublisherCommandRunner,
  type LocalUserPublicationPlanV1,
} from "../src/delivery/index.js";

const SECRET = "glpat-this-must-never-be-recorded";
const COMMIT = "b".repeat(40);

class FakeCommands implements GitLabPublisherCommandRunner {
  public readonly calls: string[][] = [];
  public protectedRules = ["main"];
  public requests: unknown[] = [];
  public username = "maintainer";
  public accessLevel = 30;
  public groupAccessLevel: number | null = null;
  public targetRevision = "a".repeat(40);
  public targetProtected = true;
  public targetExists = true;
  public lastTitle = "Draft: [DocsFab Run] update docs";
  public lastDescription = "Draft publication prepared by DocsFab.";
  public authExit = 0;
  public authStderr = "";
  public tokenProbeExit = 0;

  public async run(
    _command: "glab",
    args: readonly string[],
  ): Promise<GitLabPublisherCommandResult> {
    this.calls.push([...args]);
    const key = args.join(" ");
    if (key === "auth status --hostname gitlab.example.test") {
      return this.authExit === 0
        ? ok("")
        : {
            exitCode: 1,
            stdout: Buffer.from(SECRET),
            stderr: Buffer.from(this.authStderr),
          };
    }
    if (key === "config get token --host gitlab.example.test") {
      return { exitCode: this.tokenProbeExit, stdout: Buffer.from("") };
    }
    if (key === "api --hostname gitlab.example.test user") {
      return json({ username: this.username, token: SECRET });
    }
    if (key === "api --hostname gitlab.example.test projects/42") {
      return json({
        id: 42,
        path_with_namespace: "group/docs",
        default_branch: "main",
        permissions: {
          project_access: { access_level: this.accessLevel },
          group_access:
            this.groupAccessLevel === null ? null : { access_level: this.groupAccessLevel },
        },
        secret: SECRET,
      });
    }
    if (key === "api --hostname gitlab.example.test projects/42/repository/branches/main") {
      if (!this.targetExists) return failed();
      return json({
        name: "main",
        protected: this.targetProtected,
        commit: { id: this.targetRevision },
        secret: SECRET,
      });
    }
    if (key.includes("protected_branches?per_page=100&page=")) {
      const page = Number(new URL(`https://x/?${key.split("?")[1]}`).searchParams.get("page"));
      return json(
        this.protectedRules
          .slice((page - 1) * 100, page * 100)
          .map((name) => ({ name, token: SECRET })),
      );
    }
    if (key.includes("merge_requests?scope=all&state=all&source_branch=")) {
      const page = Number(new URL(`https://x/?${key.split("?")[1]}`).searchParams.get("page"));
      return json(this.requests.slice((page - 1) * 100, page * 100));
    }
    if (args.includes("--method") && args.includes("POST")) {
      this.lastTitle = args.find((value) => value.startsWith("title="))!.slice("title=".length);
      this.lastDescription = args
        .find((value) => value.startsWith("description="))!
        .slice("description=".length);
      const request = {
        ...mr(7),
        title: this.lastTitle,
        description: this.lastDescription,
      };
      this.requests = [request];
      return json(request);
    }
    return failed();
  }
}

describe("small GitLab publication adapter", () => {
  it("keeps an explicitly injected glab environment closed to ambient host values", async () => {
    vi.stubEnv("HOME", "/ambient-home");
    vi.stubEnv("GLAB_TOKEN", SECRET);
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", "/ambient-config");
    const fake = new FakeCommands();
    const commands: GitLabPublisherCommandRunner = {
      run(command, args, _cwd, options) {
        expect(options.env).toEqual({
          LC_ALL: "C",
          LANG: "C",
          NO_COLOR: "1",
          PAGER: "cat",
          GLAB_PAGER: "cat",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
        });
        return fake.run(command, args);
      },
    };
    try {
      await expect(
        new LocalUserGitLabPublisherAdapter(commands, {}).inspectPolicy(plan(), "/delivery"),
      ).resolves.toMatchObject({ projectId: 42, username: "maintainer" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("paginates branch protection and fails source protection closed", async () => {
    const commands = new FakeCommands();
    commands.protectedRules = [
      ...Array.from({ length: 100 }, (_item, index) => `release-${index}`),
      "docsfab-run/*",
    ];
    const adapter = new LocalUserGitLabPublisherAdapter(commands, {
      HOME: "/operator",
      GLAB_TOKEN: SECRET,
      GLAB_EDITOR: "malicious",
    });
    expect(await adapter.inspectPolicy(plan(), "/delivery")).toEqual({
      username: "maintainer",
      projectId: 42,
      projectPath: "group/docs",
      accessLevel: 30,
      defaultBranch: "main",
      targetBranch: {
        name: "main",
        protected: true,
        revision: "a".repeat(40),
      },
      sourceBranchProtected: true,
    });
    expect(
      commands.calls.filter((call) => call.join(" ").includes("protected_branches")),
    ).toHaveLength(2);
  });

  it("classifies connection-reset auth status as host-unreachable", async () => {
    const commands = new FakeCommands();
    commands.authExit = 1;
    commands.tokenProbeExit = 0;
    commands.authStderr =
      'Error using API: Get "https://gitlab.example.test/api/v4/user": connection reset by peer';
    const adapter = new LocalUserGitLabPublisherAdapter(commands, {
      HOME: "/operator",
    });
    await expect(adapter.inspectPolicy(plan(), "/delivery")).rejects.toMatchObject({
      name: "GitLabPublisherAdapterError",
      code: "host-unreachable",
    });
  });

  it("classifies 401 auth status as authentication-unavailable", async () => {
    const commands = new FakeCommands();
    commands.authExit = 1;
    commands.authStderr = "401 Unauthorized";
    const adapter = new LocalUserGitLabPublisherAdapter(commands, {
      HOME: "/operator",
    });
    await expect(adapter.inspectPolicy(plan(), "/delivery")).rejects.toMatchObject({
      name: "GitLabPublisherAdapterError",
      code: "authentication-unavailable",
    });
  });

  it("finds or opens only bounded exact draft merge requests", async () => {
    const commands = new FakeCommands();
    const adapter = new LocalUserGitLabPublisherAdapter(commands, {
      HOME: "/operator",
    });
    const metadata = buildDocsFabPublicationMetadata({
      plan: plan(),
      workflowOutcome: "Update docs",
      changedPaths: ["docs/guide.md"],
    });
    expect(await adapter.findMergeRequests(plan(), "/delivery")).toEqual([]);
    let authorizationChecks = 0;
    const opened = await adapter.openDraftMergeRequest({
      plan: plan(),
      cwd: "/delivery",
      title: metadata.mergeRequestTitle,
      description: metadata.mergeRequestDescription,
      headRevision: COMMIT,
      assertAuthorized: () => {
        authorizationChecks += 1;
      },
    });
    expect(authorizationChecks).toBe(1);
    expect(opened).toEqual({
      iid: 7,
      url: "https://gitlab.example.test/group/docs/-/merge_requests/7",
      state: "opened",
      draft: true,
      sourceBranch: "docsfab-run/run-1",
      targetBranch: "main",
      headRevision: COMMIT,
      sourceProjectId: 42,
      targetProjectId: 42,
      title: "Draft: [DocsFab Run] Update docs",
      description: metadata.mergeRequestDescription,
    });
    const post = commands.calls.find((call) => call.includes("POST"))!;
    expect(post).toContain("--method");
    expect(post).toContain("source_branch=docsfab-run/run-1");
    expect(post).toContain("target_branch=main");
    expect(post).toContain("remove_source_branch=false");
    expect(JSON.stringify(opened)).not.toContain(SECRET);
  });

  it("publishes when a shown file name carries a marker name, and still refuses a missing or duplicated marker line (#1807)", async () => {
    const finding = (location: string) => ({
      code: "credential-like-content" as const,
      location,
      rule: "credential.assigned-secret",
    });
    const provenancePath = "docs/docsfab-publication-provenance.md";
    const metadata = buildDocsFabPublicationMetadata({
      plan: plan(),
      workflowOutcome: "Update docs",
      changedPaths: [provenancePath],
      credentialFindings: [finding(`${provenancePath}:3`)],
    });
    const description = metadata.mergeRequestDescription;
    // The name is shown in the changed paths and in the Notes block.
    expect(description).toContain(`  - \`${provenancePath}\``);
    expect(description).toContain(`\`${provenancePath}:3\` (\`credential.assigned-secret\`)`);
    for (const withMetadata of [false, true]) {
      const commands = new FakeCommands();
      const opened = await new LocalUserGitLabPublisherAdapter(commands, {
        HOME: "/operator",
      }).openDraftMergeRequest({
        plan: plan(),
        cwd: "/delivery",
        title: metadata.mergeRequestTitle,
        description,
        headRevision: COMMIT,
        ...(withMetadata ? { metadata } : {}),
      });
      expect(opened.description).toBe(description);
      expect(commands.calls.some((call) => call.includes("POST"))).toBe(true);
    }
    // Only a line that opens the marker comment counts: a missing, a
    // duplicated, or a differently cased real marker line still refuses.
    const marker = metadata.mergeRequestProvenanceMarker;
    expect(hasExactDocsFabPublicationProvenance(description, marker)).toBe(true);
    expect(hasExactDocsFabPublicationProvenance(description.replace(marker, ""), marker)).toBe(
      false,
    );
    expect(hasExactDocsFabPublicationProvenance(`${description}\n${marker}`, marker)).toBe(false);
    expect(
      hasExactDocsFabPublicationProvenance(`${description}\n  ${marker.toUpperCase()}`, marker),
    ).toBe(false);

    const compositionPath = "docs/docsfab-composition-execution.md";
    const composition = buildDocsFabPublicationMetadata({
      plan: plan(),
      workflowOutcome: "Update docs",
      changedPaths: [compositionPath],
      credentialFindings: [finding(`${compositionPath}:5`)],
      compositionExecution: createCompositionPublicationBinding({
        compositionId: "openai-gpt-5.6-sol-pi",
        evidenceSha256: "e".repeat(64),
        aggregateSha256: "f".repeat(64),
      }),
    });
    expect(composition.mergeRequestDescription).toContain(`\`${compositionPath}:5\``);
    const compositionCommands = new FakeCommands();
    await new LocalUserGitLabPublisherAdapter(compositionCommands).openDraftMergeRequest({
      plan: plan(),
      cwd: "/delivery",
      title: composition.mergeRequestTitle,
      description: composition.mergeRequestDescription,
      headRevision: COMMIT,
      metadata: composition,
    });
    expect(compositionCommands.calls.some((call) => call.includes("POST"))).toBe(true);
    const compositionMarker = composition.mergeRequestCompositionMarker!;
    expect(
      hasExactDocsFabPublicationMetadata(
        composition.mergeRequestTitle,
        `${composition.mergeRequestDescription}\n${compositionMarker}`,
        composition,
      ),
    ).toBe(false);
    expect(
      hasExactDocsFabPublicationMetadata(
        composition.mergeRequestTitle,
        composition.mergeRequestDescription.replace(compositionMarker, ""),
        composition,
      ),
    ).toBe(false);
  });

  it("requires exact composition title, warning, and aggregate marker before POST", async () => {
    const publicationPlan = plan();
    const compositionExecution = createCompositionPublicationBinding({
      compositionId: "openai-gpt-5.6-sol-pi",
      evidenceSha256: "e".repeat(64),
      aggregateSha256: "f".repeat(64),
    });
    const metadata = buildDocsFabPublicationMetadata({
      plan: publicationPlan,
      workflowOutcome: "Update docs",
      changedPaths: ["docs/guide.md"],
      compositionExecution,
    });
    const acceptedCommands = new FakeCommands();
    const opened = await new LocalUserGitLabPublisherAdapter(
      acceptedCommands,
    ).openDraftMergeRequest({
      plan: publicationPlan,
      cwd: "/delivery",
      title: metadata.mergeRequestTitle,
      description: metadata.mergeRequestDescription,
      headRevision: COMMIT,
      metadata,
    });
    expect(opened.title).toBe("Draft: [DocsFab] COMPOSITION — Update docs");
    expect(acceptedCommands.calls.some((call) => call.includes("POST"))).toBe(true);

    for (const change of [
      {
        title: "Draft: [DocsFab] Update docs",
        description: metadata.mergeRequestDescription,
      },
      {
        title: metadata.mergeRequestTitle,
        description: metadata.mergeRequestDescription.replace(
          metadata.mergeRequestCompositionWarning!,
          "Warning removed.",
        ),
      },
      {
        title: metadata.mergeRequestTitle,
        description: metadata.mergeRequestDescription.replace(
          metadata.mergeRequestCompositionMarker!,
          "<!-- docsfab-composition-execution:v2 -->",
        ),
      },
    ]) {
      const commands = new FakeCommands();
      await expect(
        new LocalUserGitLabPublisherAdapter(commands).openDraftMergeRequest({
          plan: publicationPlan,
          cwd: "/delivery",
          title: change.title,
          description: change.description,
          headRevision: COMMIT,
          metadata,
        }),
      ).rejects.toMatchObject({ code: "invalid-response" });
      expect(commands.calls.some((call) => call.includes("POST"))).toBe(false);
    }
  });

  it("rejects authentication identity drift and credential-bearing selected output", async () => {
    const identity = new FakeCommands();
    identity.username = "other-maintainer";
    await expect(
      new LocalUserGitLabPublisherAdapter(identity).inspectPolicy(plan(), "/delivery"),
    ).rejects.toBeInstanceOf(GitLabPublisherAdapterError);

    const unsafe = new FakeCommands();
    unsafe.requests = [{ ...mr(7), source_branch: `docsfab-run/${SECRET}` }];
    await expect(
      new LocalUserGitLabPublisherAdapter(unsafe).findMergeRequests(plan(), "/delivery"),
    ).rejects.toMatchObject({ code: "invalid-response" });

    const fork = new FakeCommands();
    fork.requests = [{ ...mr(7), source_project_id: 99 }];
    await expect(
      new LocalUserGitLabPublisherAdapter(fork).findMergeRequests(plan(), "/delivery"),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([
    "Draft: Draft: [DocsFab Run] Update docs",
    "Draft: [DocsFab Run] [BOT] Update docs",
    "Draft: [DocsFab Run] Update [DocsFab Run] docs",
    "[DocsFab Run] Update docs",
    "Draft: [OTHER] Update docs",
    "Draft: [DocsFab Run] Codex update docs",
    "Draft: [DocsFab Run] @maintainer update docs",
  ])("rejects a non-canonical or competing automation title %j before POST", async (title) => {
    const commands = new FakeCommands();
    const publicationPlan = plan();
    const metadata = buildDocsFabPublicationMetadata({
      plan: publicationPlan,
      workflowOutcome: "Update docs",
      changedPaths: ["docs/guide.md"],
    });
    await expect(
      new LocalUserGitLabPublisherAdapter(commands).openDraftMergeRequest({
        plan: publicationPlan,
        cwd: "/delivery",
        title,
        description: metadata.mergeRequestDescription,
        headRevision: COMMIT,
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(commands.calls.some((call) => call.includes("POST"))).toBe(false);
  });

  it.each(["missing", "conflicting", "multiple"] as const)(
    "rejects a %s provenance marker before POST",
    async (kind) => {
      const commands = new FakeCommands();
      const publicationPlan = plan();
      const metadata = buildDocsFabPublicationMetadata({
        plan: publicationPlan,
        workflowOutcome: "Update docs",
        changedPaths: ["docs/guide.md"],
      });
      const marker = metadata.mergeRequestProvenanceMarker;
      const description =
        kind === "missing"
          ? "## Published by DocsFab"
          : kind === "conflicting"
            ? metadata.mergeRequestDescription.replace("v1", "v2")
            : `${metadata.mergeRequestDescription}\n${marker}`;
      await expect(
        new LocalUserGitLabPublisherAdapter(commands).openDraftMergeRequest({
          plan: publicationPlan,
          cwd: "/delivery",
          title: metadata.mergeRequestTitle,
          description,
          headRevision: COMMIT,
        }),
      ).rejects.toMatchObject({ code: "invalid-response" });
      expect(commands.calls.some((call) => call.includes("POST"))).toBe(false);
    },
  );

  it("strictly projects effective access and target-branch state with content-free failures", async () => {
    const effective = new FakeCommands();
    effective.accessLevel = 20;
    effective.groupAccessLevel = 40;
    expect(
      await new LocalUserGitLabPublisherAdapter(effective).inspectPolicy(plan(), "/delivery"),
    ).toMatchObject({
      accessLevel: 40,
      targetBranch: { name: "main", protected: true },
    });

    const malformed = new FakeCommands();
    malformed.targetRevision = SECRET;
    let malformedError: unknown;
    try {
      await new LocalUserGitLabPublisherAdapter(malformed).inspectPolicy(plan(), "/delivery");
    } catch (error) {
      malformedError = error;
    }
    expect(malformedError).toMatchObject({ code: "invalid-response" });
    expect(String(malformedError)).not.toContain(SECRET);

    const deleted = new FakeCommands();
    deleted.targetExists = false;
    await expect(
      new LocalUserGitLabPublisherAdapter(deleted).inspectPolicy(plan(), "/delivery"),
    ).rejects.toMatchObject({ code: "external-failure" });
  });

  it("copies XDG, GLAB_CONFIG_DIR, and GITLAB_HOST into the glab allowlist", () => {
    expect(
      glabEnvironment({
        PATH: "/bin",
        HOME: "/operator",
        XDG_CONFIG_HOME: "/xdg",
        GLAB_CONFIG_DIR: "/glab-config",
        GITLAB_HOST: "gitlab.example.test",
        GLAB_EDITOR: "malicious",
      }),
    ).toMatchObject({
      HOME: "/operator",
      XDG_CONFIG_HOME: "/xdg",
      GLAB_CONFIG_DIR: "/glab-config",
      GITLAB_HOST: "gitlab.example.test",
    });
    expect(glabEnvironment({ HOME: "/operator", GLAB_EDITOR: "malicious" }).GLAB_EDITOR).toBe(
      undefined,
    );
  });
});

function mr(iid: number) {
  return {
    iid,
    state: "opened",
    draft: true,
    title: "Draft: DocsFab update",
    description: "Draft publication prepared by DocsFab.",
    source_branch: "docsfab-run/run-1",
    target_branch: "main",
    sha: COMMIT,
    source_project_id: 42,
    target_project_id: 42,
    token: SECRET,
  };
}

function ok(stdout: string): GitLabPublisherCommandResult {
  return { exitCode: 0, stdout: Buffer.from(stdout) };
}

function json(value: unknown): GitLabPublisherCommandResult {
  return ok(JSON.stringify(value));
}

function failed(): GitLabPublisherCommandResult {
  return { exitCode: 1, stdout: Buffer.from(SECRET) };
}

function plan(): LocalUserPublicationPlanV1 {
  const candidate = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "run-1", recordSha256: "d".repeat(64) },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "ssh" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: "a".repeat(40),
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/run-1",
    patch: {
      format: "git-diff",
      sha256: createHash("sha256").update("patch").digest("hex"),
      byteLength: 5,
      changedFileCount: 1,
    },
    validationCommand: "npm run check",
    mergeRequest: { draft: true },
    fallback: { mode: "patch-only", preserved: true },
    checks: {
      repository: "passed",
      remote: "passed",
      revision: "current",
      gitIdentity: "configured",
      gitlabAuthentication: "authenticated",
      pushAccess: "allowed",
      sourceBranch: "unprotected",
    },
  } as const;
  return {
    ...candidate,
    sha256: localUserPublicationPlanSha256(candidate as never),
  };
}
