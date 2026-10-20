// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { limit } from "../src/config/limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { GIT_CONFIGURATION_LISTING_LIMIT } from "../src/delivery/git-config-policy.js";
import {
  authorizeLocalUserPublication,
  deterministicLocalUserSourceBranch,
  DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND,
  ExecFileGitPublisherCommandRunner,
  ExecFileReadOnlyCommandRunner,
  loadVerifiedPublicationRun,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  LocalUserPublicationPreflightError,
  parseGitLabRemote,
  preflightLocalUserGitLabPublication,
  serializeLocalUserPublicationPlan,
  type LocalUserPublicationPreflightContext,
  type ReadOnlyCommandRunner,
  type ReadOnlyCommandResult,
} from "../src/delivery/index.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { inferRemediationId, remediationText } from "../src/operator/remediation.js";
import { decodeSuccessfulPublicationRunRecord } from "../src/delivery/run-record.js";
import { authorizeSecurityScan } from "../src/security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "../src/security/scan-disposition.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  createWorkflowOutcome,
  defaultInconclusiveWorkflowOutcome,
} from "../src/workflow-contracts/outcome.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { collectCredentialLikeContent } from "../src/security/repository-credential-findings.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(40);
const SECRET = "glpat-this-must-never-be-recorded";
const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;
const temporaryDirectories = temporaryRoots();

interface Fixture {
  root: string;
  repository: string;
  recordPath: string;
  patchPath: string;
}

/**
 * These tests drive preflight over FakeCommands, whose checkout is a plain
 * directory and not a Git repository, so the private validation candidate
 * cannot be built. This seam derives the binding over that directory; the
 * real candidate is covered by the delivery-worktree seam tests (#2359).
 */
const CHECKOUT_CANDIDATE_CONTEXT: LocalUserPublicationPreflightContext = {
  validationCandidate: async (input, action) => action(input.repositoryPath),
};

class FakeCommands implements ReadOnlyCommandRunner {
  public readonly calls: Array<{
    command: string;
    args: readonly string[];
    cwd: string;
    options?: { env?: NodeJS.ProcessEnv; maxOutputBytes?: number };
  }> = [];
  public remoteOutput = "origin\n";
  public remoteUrl = "https://gitlab.example.test/group/docs.git\n";
  public pushRemoteUrl = "https://gitlab.example.test/group/docs.git\n";
  public gitName = `Maintainer ${SECRET}\n`;
  public gitEmail = `${SECRET}@example.test\n`;
  public glabName = "Maintainer From Glab";
  public glabEmail = "maintainer@users.noreply.gitlab.example.test";
  public glabVersionExit = 0;
  public authExit = 0;
  public authStderr = "";
  public tokenProbe: "present" | "missing" | "unverified" = "missing";
  public trackingRevision = REVISION;
  public projectAccess = 30;
  public branchRevision = REVISION;
  public mergeBaseRevision?: string;
  /** The merge_base API answer when GitLab cannot compute one (#2120). */
  public mergeBaseFailure?: ReadOnlyCommandResult;
  /** The `repository/commits/<sha>` answer; unset means a content-free failure. */
  public commitProbe?: ReadOnlyCommandResult;
  public branchProtected = true;
  public protectedRules: string[] = ["main", "release/*"];
  public trackedStatus = "";
  public insideWorkTree = true;
  public topLevel?: string;
  public localConfigList = "";
  public localConfigExit = 0;
  /** The effective configuration with origins, as `git config --includes --show-origin --null --list` prints it. */
  public effectiveConfigList = "";
  public effectiveConfigExit = 0;
  /** What stopped the read, as the real runner reports it: the output bound or the timeout. */
  public effectiveConfigFailure?: "output-limit" | "timeout";
  public headCommit?: string;
  public projectPath = "group/docs";
  public projectId = 42;
  public graphqlFullPath: string | null = null;
  public graphqlProjectId: string | null = null;

  public async run(
    command: "git" | "glab" | "gh",
    args: readonly string[],
    cwd: string,
    options?: { env?: NodeJS.ProcessEnv; maxOutputBytes?: number },
  ): Promise<ReadOnlyCommandResult> {
    this.calls.push({ command, args: [...args], cwd, options });
    if (command === "gh") throw new Error("GitLab fixture does not support gh.");
    if (command === "git") return this.git(args, cwd);
    return this.glab(args);
  }

  private git(args: readonly string[], cwd: string): ReadOnlyCommandResult {
    const key = stripSafeGitConfig(args).join(" ");
    if (key === "config --local --null --list") {
      return this.localConfigExit === 0 ? ok(this.localConfigList) : failed();
    }
    if (key === "config --includes --show-origin --null --list") {
      // A failing read still prints what it had: only its exit status says it failed.
      return {
        exitCode: this.effectiveConfigExit,
        stdout: this.effectiveConfigList,
        ...(this.effectiveConfigFailure ? { failure: this.effectiveConfigFailure } : {}),
      };
    }
    if (key === "rev-parse --is-inside-work-tree") {
      return this.insideWorkTree ? ok("true\n") : failed();
    }
    if (key === "rev-parse --show-toplevel") return ok(`${this.topLevel ?? cwd}\n`);
    if (key === "symbolic-ref --quiet --short HEAD") return ok("work\n");
    if (key === "rev-parse --verify --end-of-options HEAD^{commit}") {
      return ok(`${this.headCommit ?? this.branchRevision}\n`);
    }
    if (key === "status --porcelain=v2 -z --untracked-files=no") return ok(this.trackedStatus);
    if (key === "remote") return ok(this.remoteOutput);
    if (key === "remote get-url --all origin") return ok(this.remoteUrl);
    if (key === "remote get-url --push --all origin") return ok(this.pushRemoteUrl);
    if (key === "config --get user.name") return ok(this.gitName);
    if (key === "config --get user.email") return ok(this.gitEmail);
    if (key === `cat-file -e ${REVISION}^{commit}`) return ok("");
    if (key === "rev-parse --verify refs/remotes/origin/main^{commit}") {
      return ok(`${this.trackingRevision}\n`);
    }
    return failed();
  }

  private glab(args: readonly string[]): ReadOnlyCommandResult {
    const key = args.join(" ");
    if (key === "version") return this.glabVersionExit === 0 ? ok("glab 1\n") : failed();
    if (key === "auth status --hostname gitlab.example.test") {
      return this.authExit === 0
        ? ok("")
        : { exitCode: 1, stdout: SECRET, stderr: this.authStderr };
    }
    if (key === "config get token --host gitlab.example.test") {
      if (this.tokenProbe === "present") return ok("");
      if (this.tokenProbe === "unverified") return { exitCode: 2, stdout: "" };
      return failed();
    }
    if (key === "api --hostname gitlab.example.test user") {
      return json({
        username: "maintainer",
        name: this.glabName,
        email: this.glabEmail,
        token: SECRET,
      });
    }
    if (
      key === `api --hostname gitlab.example.test projects/${encodeURIComponent(this.projectPath)}`
    ) {
      return failed();
    }
    if (args[0] === "api" && args[1] === "--hostname" && args[3] === "graphql") {
      const fullPath = graphqlRawField(args, "fullPath");
      if (fullPath !== this.projectPath) return failed();
      return json({
        data: {
          project: {
            id: this.graphqlProjectId ?? `gid://gitlab/Project/${this.projectId}`,
            fullPath: this.graphqlFullPath ?? this.projectPath,
          },
        },
        token: SECRET,
      });
    }
    if (key === `api --hostname gitlab.example.test projects/${this.projectId}`) {
      return json({
        id: this.projectId,
        path_with_namespace: this.projectPath,
        default_branch: "main",
        permissions: {
          project_access: { access_level: this.projectAccess },
          group_access: null,
        },
        credential: SECRET,
      });
    }
    if (
      key ===
      `api --hostname gitlab.example.test projects/${this.projectId}/repository/branches/main`
    ) {
      return json({
        name: "main",
        protected: this.branchProtected,
        commit: { id: this.branchRevision },
        secret: SECRET,
      });
    }
    if (args[0] === "api" && args[1] === "--hostname" && args[3]?.startsWith("projects/")) {
      const mergeBaseMatch =
        /^projects\/(\d+)\/repository\/merge_base\?refs\[\]=(.+)&refs\[\]=(.+)$/u.exec(args[3]!);
      if (mergeBaseMatch) {
        if (this.mergeBaseFailure !== undefined) return this.mergeBaseFailure;
        const left = mergeBaseMatch[2]!.toLowerCase();
        const right = mergeBaseMatch[3]!.toLowerCase();
        const ancestor = left.length <= right.length ? left : right;
        const descendant = left.length <= right.length ? right : left;
        if (this.mergeBaseRevision !== undefined) {
          return json({ id: this.mergeBaseRevision });
        }
        if (
          ancestor === REVISION.toLowerCase() &&
          descendant === this.branchRevision.toLowerCase()
        ) {
          return json({ id: REVISION });
        }
        if (
          ancestor === this.branchRevision.toLowerCase() &&
          descendant === REVISION.toLowerCase()
        ) {
          return json({ id: this.branchRevision });
        }
        return json({ id: "c".repeat(40) });
      }
      if (/^projects\/\d+\/repository\/commits\/[a-f0-9]{40}$/u.test(args[3]!)) {
        return this.commitProbe ?? failed();
      }
    }
    if (
      key ===
      `api --hostname gitlab.example.test projects/${this.projectId}/protected_branches?per_page=100`
    ) {
      return json(
        this.protectedRules.map((name) => ({
          name,
          push_access_levels: [{ token: SECRET }],
        })),
      );
    }
    return failed();
  }
}

function stripSafeGitConfig(args: readonly string[]): readonly string[] {
  let index = 0;
  while (args[index] === "-c" && args[index + 1] !== undefined) index += 2;
  return args.slice(index);
}

describe("local-user GitLab publication preflight", () => {
  afterEach(() => {
    delete process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES;
  });

  it("loads a run record at runs.recordMaxBytes and refuses one byte more by that limit's code (#1932)", async () => {
    const fixture = await createFixture();
    const text = (await readFile(fixture.recordPath, "utf8")).trimEnd();
    const bound = 8192;
    process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES = String(bound);
    // JSON admits trailing whitespace, so padding changes the size and nothing else.
    const padded = (bytes: number) => `${text}${" ".repeat(bytes - Buffer.byteLength(text))}`;

    await writeFile(fixture.recordPath, padded(bound), { mode: 0o600 });
    await expect(loadVerifiedPublicationRun(fixture.recordPath, "run-1")).resolves.toMatchObject({
      id: "run-1",
    });

    await writeFile(fixture.recordPath, padded(bound + 1), { mode: 0o600 });
    const refusal = await loadVerifiedPublicationRun(fixture.recordPath, "run-1").catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(LocalUserPublicationPreflightError);
    expect(refusal).toMatchObject({ code: "runs-record-max-bytes-bound" });
    expect((refusal as Error).message).toContain(
      "runs-record-max-bytes-bound: 8193 exceeds runs.recordMaxBytes = 8192 bytes. Set DOCSFAB_RUNS_RECORD_MAX_BYTES",
    );
    expect((refusal as Error).message).not.toContain("invalid-run-record");
  });

  it("publishes a live-agent write whose record carries instructionContext (#1233)", async () => {
    const fixture = await createFixture();
    const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    const instructionContext = "MR !1076 diff and reader evidence for the live agent.";
    parsed.instructionContext = instructionContext;
    await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });

    const run = await loadVerifiedPublicationRun(fixture.recordPath, "run-1");
    expect(run.id).toBe("run-1");
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.run.id).toBe("run-1");
    // Admitted, not published: the plan stays content-minimized.
    expect(serializeLocalUserPublicationPlan(plan)).not.toContain(instructionContext);
  });

  it("publishes a write run that carries credential-like-content findings (#1807)", async () => {
    const fixture = await createFixture();
    const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    // Findings as the runner records them, including a path with a control
    // character and one longer than any record reader admits: a heuristic
    // finding must never stop publication.
    const longPath = `docs/${"deep/".repeat(260)}page.md`;
    const { findings } = await collectCredentialLikeContent({
      runId: "run-1",
      workspacePath: fixture.repository,
      report: {
        ruleSet: "credential-rules-v1",
        status: "blocked",
        scannedFiles: 3,
        binaryFiles: 0,
        findings: [
          { path: "README.md", ruleId: "credential.assigned-secret" },
          { path: "docs/tab\u0009and\u0001bell.md", ruleId: "credential.assigned-secret" },
          { path: longPath, ruleId: "credential.assigned-secret" },
        ],
      },
    });
    expect(findings).toHaveLength(3);
    parsed.credentialFindings = findings;
    await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });

    const run = await loadVerifiedPublicationRun(fixture.recordPath, "run-1");
    expect(run.id).toBe("run-1");
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.run.id).toBe("run-1");
  });

  it("writes a finding location's control, format and separator characters escaped, so the record decodes and runs show prints one line (#1807)", async () => {
    const fixture = await createFixture();
    const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    // A right-to-left override, a C1 control, the line and paragraph
    // separators, and a tab, each able to rewrite or split a printed line.
    const path = [
      "docs/a",
      "\u202e",
      "b",
      "\u009b",
      "c",
      "\u2028",
      "d",
      "\u2029",
      "e",
      "\t",
      "f.md",
    ].join("");
    const escaped = "docs/a\\u202eb\\u009bc\\u2028d\\u2029e\\u0009f.md";
    const { findings } = await collectCredentialLikeContent({
      runId: "run-1",
      workspacePath: fixture.repository,
      report: {
        ruleSet: "credential-rules-v1",
        status: "blocked",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [{ path, ruleId: "credential.assigned-secret" }],
      },
    });
    expect(findings.map((finding) => finding.location)).toEqual([escaped]);
    parsed.credentialFindings = findings;
    await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });

    // The record round-trips through the publication decoder.
    const reread = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    expect(() => decodeSuccessfulPublicationRunRecord(reread)).not.toThrow();
    expect((await loadVerifiedPublicationRun(fixture.recordPath, "run-1")).id).toBe("run-1");

    // runs show prints the location escaped, on one line.
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => lines.push(String(message ?? ""));
    try {
      await handleRunsCommand(["show", "run-1", "--state-dir", dirname(fixture.recordPath)]);
    } finally {
      console.log = originalLog;
    }
    const human = lines.join("\n");
    expect(human).toContain(`  ${escaped} (credential.assigned-secret)`);
    for (const raw of ["\u202e", "\u009b", "\u2028", "\u2029", "\t"]) {
      expect(human).not.toContain(raw);
    }
  });

  it("refuses to publish a patch that holds a configured credential, and publishes a credential shape (#1807)", async () => {
    const fixture = await createFixture();
    // A configured value that does not look like a credential: only the
    // exact match finds it in the pushed patch bytes.
    const credential = configureCredential(["harbor", plantedCredentialValue(88, 24)].join("-"));
    await replacePatch(fixture, `diff --git a/README.md b/README.md\n+key ${credential}\n`);
    const refusal = await captureFailure(fixture, new FakeCommands());
    expect(refusal.code).toBe("patch-credential-material");
    expect(refusal.message).not.toContain(credential);
    expect(refusal.action).toContain("Remove the configured credential from the changed files");

    // A credential shape that is not configured is the maintainers' to judge.
    const shaped = ["glpat", plantedCredentialValue(89, 20)].join("-");
    await replacePatch(fixture, `diff --git a/README.md b/README.md\n+token ${shaped}\n`);
    const run = await loadVerifiedPublicationRun(fixture.recordPath, "run-1");
    expect(run.patchBytes.toString("utf8")).toContain(shaped);
  });

  it("refuses a patch that holds a configured credential even when a required check could not run (#1918, #1807)", async () => {
    const fixture = await createFixture();
    const line =
      "required check could not run: `ruff format .` (unsupported check form). Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change.";
    const finding = {
      code: "credential-like-content",
      location: "docs/a.md:3",
      rule: "credential.jwt",
    };
    const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    parsed.evidenceWarnings = [line];
    parsed.credentialFindings = [finding];
    await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    // Positive control: a delivered limitation and a flagged finding both carry
    // over to the draft MR's Notes.
    const run = await loadVerifiedPublicationRun(fixture.recordPath, "run-1");
    expect(run.requiredCheckLimitations).toEqual([line]);
    expect(run.credentialFindings).toEqual([finding]);

    // The configured-credential screen of the patch runs first, whatever the
    // limitations: a patch with DocsFab's own credential is never delivered.
    const credential = configureCredential(["harbor", plantedCredentialValue(90, 24)].join("-"));
    await replacePatch(fixture, `diff --git a/README.md b/README.md\n+key ${credential}\n`);
    const refusal = await captureFailure(fixture, new FakeCommands());
    expect(refusal.code).toBe("patch-credential-material");
    expect(refusal.message).not.toContain(credential);
    await expect(loadVerifiedPublicationRun(fixture.recordPath, "run-1")).rejects.toMatchObject({
      code: "patch-credential-material",
    });
  });

  it("builds a deterministic, content-minimized HTTPS plan without mutations", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    const before = await directorySnapshot(fixture.repository);
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      commands,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );

    expect(plan).toMatchObject({
      schemaVersion: 2,
      deliveryMode: "local-user",
      authorityBasis: "interactive-once",
      project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
      remote: { name: "origin", transport: "https" },
      identity: {
        git: "configured",
        gitIdentitySha256: localUserGitIdentitySha256(commands.gitName, commands.gitEmail),
        gitlabUsername: "maintainer",
      },
      baseRevision: REVISION,
      targetBranch: { name: "main", protected: true },
      proposedSourceBranch: deterministicLocalUserSourceBranch(
        "run-1",
        REVISION,
        plan.run.recordSha256,
        plan.patch.sha256,
      ),
      validationCommand: DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND,
      mergeRequest: { draft: true },
      fallback: { mode: "patch-only", preserved: true },
    });
    expect(plan.documentationValidation?.profileId).toBe("docsfab-documentation-validation");
    expect(plan.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = serializeLocalUserPublicationPlan(plan);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(fixture.root);
    expect(await directorySnapshot(fixture.repository)).toEqual(before);
    expect(commands.calls.every(readOnlyCall)).toBe(true);
    const gitCalls = commands.calls.filter((call) => call.command === "git");
    // The operator's user.name and user.email are read the way the host
    // publisher reads them, with the real HOME, so a global identity counts
    // (#2362). So is the effective Git configuration, which preflight checks
    // against the publisher's own policy (#2363). Every other Git read stays
    // isolated from the operator's config.
    const identityRead = (call: (typeof gitCalls)[number]) =>
      call.args.at(-2) === "--get" && ["user.name", "user.email"].includes(call.args.at(-1) ?? "");
    const configurationRead = (call: (typeof gitCalls)[number]) =>
      call.args.includes("--show-origin");
    expect(gitCalls.filter(identityRead).map((call) => call.args.at(-1))).toEqual([
      "user.name",
      "user.email",
    ]);
    expect(gitCalls.filter(configurationRead)).toHaveLength(1);
    expect(
      gitCalls
        .filter((call) => identityRead(call) || configurationRead(call))
        .every(
          (call) =>
            call.options?.env?.GIT_NO_REPLACE_OBJECTS === "1" &&
            call.options.env.HOME === process.env.HOME &&
            call.options.env.GLAB_TOKEN === undefined &&
            call.args.includes("core.hooksPath=/dev/null"),
        ),
    ).toBe(true);
    expect(
      gitCalls
        .filter((call) => !identityRead(call) && !configurationRead(call))
        .every(
          (call) =>
            call.options?.env?.GIT_NO_REPLACE_OBJECTS === "1" &&
            call.options.env.GIT_GRAFT_FILE === "/dev/null" &&
            call.options.env.HOME === "/dev/null" &&
            call.options.env.GLAB_TOKEN === undefined,
        ),
    ).toBe(true);

    const repeated = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(repeated).toEqual(plan);

    const changedIdentity = new FakeCommands();
    changedIdentity.gitEmail = "different-maintainer@example.test\n";
    const changedPlan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      changedIdentity,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(changedPlan.identity.gitIdentitySha256).not.toBe(plan.identity.gitIdentitySha256);
    expect(changedPlan.sha256).not.toBe(plan.sha256);
    expect(serializeLocalUserPublicationPlan(changedPlan)).not.toContain(
      "different-maintainer@example.test",
    );
  });

  it("reads the Git identity without the SSH agent socket or the login names", async () => {
    // The identity read keeps HOME so a global identity counts. It needs nothing
    // that reaches an SSH agent or names the operator's account.
    vi.stubEnv("SSH_AUTH_SOCK", "/run/docsfab-test/agent.sock");
    vi.stubEnv("USER", "operator");
    vi.stubEnv("LOGNAME", "operator");
    try {
      // Positive control: the host publisher's own Git environment does carry them.
      const { gitEnvironment } = await import("../src/delivery/git-environment.js");
      expect(gitEnvironment(process.env)).toMatchObject({
        SSH_AUTH_SOCK: "/run/docsfab-test/agent.sock",
        USER: "operator",
        LOGNAME: "operator",
      });
      const fixture = await createFixture();
      const commands = new FakeCommands();
      await preflightLocalUserGitLabPublication(
        {
          runId: "run-1",
          runRecordPath: fixture.recordPath,
          repositoryPath: fixture.repository,
          draftMergeRequest: true,
        },
        commands,
        {},
        CHECKOUT_CANDIDATE_CONTEXT,
      );
      const reads = commands.calls.filter(
        (call) =>
          call.command === "git" &&
          call.args.at(-2) === "--get" &&
          ["user.name", "user.email"].includes(call.args.at(-1) ?? ""),
      );
      expect(reads).toHaveLength(2);
      for (const read of reads) {
        expect(read.options?.env?.HOME).toBe(process.env.HOME);
        for (const name of ["SSH_AUTH_SOCK", "USER", "LOGNAME"]) {
          expect(read.options?.env).not.toHaveProperty(name);
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves nested projects by GraphQL fullPath when encoded REST paths 404", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.projectPath = "tech-docs/agents/docsfab";
    commands.projectId = 99;
    commands.remoteUrl = "https://gitlab.example.test/tech-docs/agents/docsfab.git\n";
    commands.pushRemoteUrl = commands.remoteUrl;
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      commands,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.project).toEqual({
      id: 99,
      host: "gitlab.example.test",
      path: "tech-docs/agents/docsfab",
    });
    expect(serializeLocalUserPublicationPlan(plan)).not.toContain(SECRET);
    expect(
      commands.calls.every((call) => !call.args.some((argument) => argument.includes(SECRET))),
    ).toBe(true);
    expect(
      commands.calls.some(
        (call) =>
          call.command === "glab" &&
          call.args.includes("graphql") &&
          call.args.includes("fullPath=tech-docs/agents/docsfab"),
      ),
    ).toBe(true);
    expect(
      commands.calls.some(
        (call) =>
          call.command === "glab" &&
          call.args.includes(`projects/${encodeURIComponent("tech-docs/agents/docsfab")}`),
      ),
    ).toBe(false);
    expect(
      commands.calls.some((call) => call.command === "glab" && call.args.includes("projects/99")),
    ).toBe(true);
  });

  it("rejects GraphQL fullPath that does not match the selected remote", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.graphqlFullPath = "other/docs";
    expect((await captureFailure(fixture, commands)).code).toBe("project-mismatch");
  });

  it("accepts explicit --validation-command true without expanding it into a profile", async () => {
    const fixture = await createFixture();
    const explicit = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        validationCommand: "true",
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(explicit.validationCommand).toBe("true");
    expect(explicit.documentationValidation).toBeUndefined();
  });

  it("keeps the documentation profile when explicit --validation-command matches the default", async () => {
    const fixture = await createFixture();
    const implicit = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    const explicit = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        validationCommand: implicit.validationCommand,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(explicit.sha256).toBe(implicit.sha256);
    expect(explicit.documentationValidation).toEqual(implicit.documentationValidation);
  });

  it("selects a built-in documentation profile instead of package.json or true", async () => {
    const fixture = await createFixture();
    const withoutPackage = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(withoutPackage.validationCommand).toBe(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND);
    expect(withoutPackage.validationCommand).not.toBe("true");
    expect(withoutPackage.validationCommand).not.toBe("npm run check");
    expect(withoutPackage.documentationValidation?.profileId).toBe(
      "docsfab-documentation-validation",
    );
    expect(withoutPackage.documentationValidation?.checkIds).toEqual([
      "candidate-input-tree",
      "documentation-source-applicability",
      "documentation-paths-readable",
      "documentation-relative-links",
      "documentation-navigation-targets",
      "isolation-boundary",
    ]);
    expect(withoutPackage.documentationValidation).toMatchObject({
      schemaVersion: 2,
      profileVersion: "2",
      applicabilitySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(serializeLocalUserPublicationPlan(withoutPackage)).not.toContain("package.json");
    expect(serializeLocalUserPublicationPlan(withoutPackage)).not.toContain(".docsfab.json");

    await writeFile(
      join(fixture.repository, "package.json"),
      `${JSON.stringify({ scripts: { test: "echo test" } })}\n`,
    );
    await writeFile(
      join(fixture.repository, ".docsfab.json"),
      `${JSON.stringify({ validationCommand: "npm run check" })}\n`,
    );
    const withRepoConfig = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(withRepoConfig.validationCommand).toBe(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND);
    expect(withRepoConfig.documentationValidation?.profileId).toBe(
      withoutPackage.documentationValidation?.profileId,
    );
    expect(withRepoConfig.documentationValidation?.checkSetSha256).toBe(
      withoutPackage.documentationValidation?.checkSetSha256,
    );

    await writeFile(
      join(fixture.repository, "package.json"),
      `${JSON.stringify({ scripts: { check: "npm run lint" } })}\n`,
    );
    const withCheck = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(withCheck.validationCommand).not.toBe("npm run check");
    expect(withCheck.validationCommand).toBe(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND);
  });

  it.each(["tech-docs/agents/docsfab", "Tech-Docs/Agents/DocsFab"])(
    "admits DocsFab through ordinary publication preflight: %s",
    async (projectPath) => {
      const fixture = await createFixture();
      const commands = new FakeCommands();
      commands.projectPath = projectPath;
      commands.remoteUrl = `https://gitlab.example.test/${projectPath}.git\n`;
      commands.pushRemoteUrl = commands.remoteUrl;
      const plan = await preflightLocalUserGitLabPublication(
        {
          runId: "run-1",
          runRecordPath: fixture.recordPath,
          repositoryPath: fixture.repository,
          draftMergeRequest: true,
        },
        commands,
        {},
        CHECKOUT_CANDIDATE_CONTEXT,
      );
      expect(plan.project.path).toBe(projectPath);
      expect(plan.mergeRequest.draft).toBe(true);
      expect(plan.checks.pushAccess).toBe("allowed");
      commands.authExit = 1;
      expect((await captureFailure(fixture, commands)).code).toBe("gitlab-unauthenticated");
      commands.authExit = 0;
      commands.projectAccess = 20;
      expect((await captureFailure(fixture, commands)).code).toBe("insufficient-push-access");
    },
  );

  it("mentions glab auth login only for gitlab-unauthenticated publication preflight", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.authExit = 1;
    const error = await captureFailure(fixture, commands);
    expect(error.code).toBe("gitlab-unauthenticated");
    expect(inferRemediationId(error)).toBe("glab-auth-login");

    const printed = formatOperatorErrorEnvelope(toOperatorErrorEnvelope(error));
    expect(printed).toMatch(/glab auth login --hostname <host from the selected remote>/u);
    expect(printed).not.toMatch(/non-factory product repository/u);
  });

  it("maps connection-reset auth status to gitlab-unreachable without a login NEXT", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.authExit = 1;
    commands.tokenProbe = "present";
    commands.authStderr =
      'Error using API: Get "https://gitlab.example.test/api/v4/user": connection reset by peer';
    const error = await captureFailure(fixture, commands);
    expect(error.code).toBe("gitlab-unreachable");
    expect(inferRemediationId(error)).toBe("retry-gitlab-api");

    const printed = formatOperatorErrorEnvelope(toOperatorErrorEnvelope(error));
    expect(printed).toContain(remediationText("retry-gitlab-api"));
    expect(printed).not.toMatch(/glab auth login/iu);
    expect(printed).not.toContain("gitlab.example.test");
    expect(printed).not.toContain(SECRET);
  });

  it("accepts canonical GitLab SSH and HTTPS remotes and rejects credentialed or unsupported URLs", () => {
    expect(parseGitLabRemote("git@gitlab.example.test:group/docs.git")).toEqual({
      host: "gitlab.example.test",
      projectPath: "group/docs",
      transport: "ssh",
    });
    expect(parseGitLabRemote("ssh://git@gitlab.example.test/group/docs.git")).toEqual({
      host: "gitlab.example.test",
      projectPath: "group/docs",
      transport: "ssh",
    });
    expect(parseGitLabRemote("ssh://git@gitlab.example.test:12051/group/docs.git")).toEqual({
      host: "gitlab.example.test",
      projectPath: "group/docs",
      transport: "ssh",
    });
    expect(parseGitLabRemote("https://gitlab.example.test/group/docs.git")).toEqual({
      host: "gitlab.example.test",
      projectPath: "group/docs",
      transport: "https",
    });
    for (const value of [
      `https://oauth2:${SECRET}@gitlab.example.test/group/docs.git`,
      "git://gitlab.example.test/group/docs.git",
      "git@github.com:group/docs.git",
      "https://gitlab.example.test/group/docs.git?token=value",
      "ssh://git@gitlab.example.test:65536/group/docs.git",
    ]) {
      try {
        parseGitLabRemote(value);
        throw new Error("Expected remote rejection.");
      } catch (error) {
        expect(error).toBeInstanceOf(LocalUserPublicationPreflightError);
        expect((error as LocalUserPublicationPreflightError).code).toBe("unsupported-remote");
      }
    }
  });

  it("allows publication when GitLab target ff-forwarded after the run base was recorded", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.branchRevision = "b".repeat(40);
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      commands,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.checks.revision).toBe("ancestor-of-target");
    expect(plan.baseRevision).toBe(REVISION);
  });

  it.each([
    [
      "missing remote",
      (commands: FakeCommands) => {
        commands.remoteOutput = "";
      },
      "missing-remote",
    ],
    [
      "ambiguous remote",
      (commands: FakeCommands) => {
        commands.remoteOutput = "glab-base\nupstream\n";
      },
      "ambiguous-remote",
    ],
    [
      "ambiguous URL",
      (commands: FakeCommands) => {
        commands.remoteUrl += "https://gitlab.example.test/other/docs.git\n";
      },
      "ambiguous-remote-url",
    ],
    [
      "mismatched push URL",
      (commands: FakeCommands) => {
        commands.pushRemoteUrl = "https://gitlab.example.test/other/docs.git\n";
      },
      "project-mismatch",
    ],
    [
      "unavailable glab",
      (commands: FakeCommands) => {
        commands.glabVersionExit = 1;
      },
      "glab-unavailable",
    ],
    [
      "unauthenticated glab",
      (commands: FakeCommands) => {
        commands.authExit = 1;
      },
      "gitlab-unauthenticated",
    ],
    [
      "insufficient access",
      (commands: FakeCommands) => {
        commands.projectAccess = 20;
      },
      "insufficient-push-access",
    ],
    [
      "diverged GitLab target",
      (commands: FakeCommands) => {
        commands.branchRevision = "b".repeat(40);
        commands.mergeBaseRevision = "c".repeat(40);
      },
      "stale-revision",
    ],
  ])("fails closed for %s with content-free diagnostics", async (_label, mutate, code) => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    mutate(commands);
    const error = await captureFailure(fixture, commands);
    expect(error).toBeInstanceOf(LocalUserPublicationPreflightError);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(fixture.root);
  });

  it("prefers origin when several remotes exist and none is requested", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.remoteOutput = "origin\nupstream\n";
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      commands,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.remote.name).toBe("origin");
  });

  it("requires an explicit remote selection when several remotes exist", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.remoteOutput = "origin\nupstream\n";
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        remoteName: "origin",
        draftMergeRequest: true,
      },
      commands,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.remote.name).toBe("origin");
  });

  it("does not require a clean source index to observe remotes and GitLab", async () => {
    const fixture = await createFixture();
    const dirty = new FakeCommands();
    dirty.trackedStatus = "1 .M N... 100644 100644 100644 a a README.md\0";
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      dirty,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.checks.repository).toBe("passed");
    expect(
      dirty.calls.some(
        (call) =>
          stripSafeGitConfig(call.args).join(" ") ===
          "status --porcelain=v2 -z --untracked-files=no",
      ),
    ).toBe(false);
  });

  it("splits source observation failures instead of collapsing them into repository-mismatch", async () => {
    const fixture = await createFixture();

    const missingGit = new FakeCommands();
    missingGit.insideWorkTree = false;
    const missingError = await captureFailure(fixture, missingGit);
    expect(missingError.code).toBe("not-a-git-repository");
    expect(missingError.message).not.toMatch(/recorded by the (?:succeeded )?run/u);
    expect(inferRemediationId(missingError)).toBe("select-git-repository");

    const nested = new FakeCommands();
    const other = join(fixture.root, "other");
    await mkdir(other);
    nested.topLevel = other;
    const nestedError = await captureFailure(fixture, nested);
    expect(nestedError.code).toBe("not-repository-root");
    expect(inferRemediationId(nestedError)).toBe("use-git-repository-root");

    const unsafe = new FakeCommands();
    unsafe.localConfigList = "core.hooksPath\n.hooks\0";
    const unsafeError = await captureFailure(fixture, unsafe);
    expect(unsafeError.code).toBe("unsafe-git-configuration");
    expect(inferRemediationId(unsafeError)).toBe("remove-unsafe-git-configuration");

    const invalidHead = new FakeCommands();
    invalidHead.headCommit = "not-a-commit";
    const invalidHeadError = await captureFailure(fixture, invalidHead);
    expect(invalidHeadError.code).toBe("head-revision-invalid");
    const invalidHeadPrinted = formatOperatorErrorEnvelope(
      toOperatorErrorEnvelope(invalidHeadError),
    );
    expect(invalidHeadPrinted).toContain("Next action:");
    expect(invalidHeadPrinted).toMatch(/named branch whose HEAD is a Git commit/u);

    const recorded = join(fixture.root, "recorded");
    await mkdir(recorded);
    const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8")) as {
      repository: { sourcePath: string };
    };
    parsed.repository.sourcePath = recorded;
    await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    const mismatch = await captureFailure(fixture, new FakeCommands());
    expect(mismatch.code).toBe("repository-mismatch");
    expect(mismatch.message).toMatch(/same --repo path the succeeded run recorded/u);
    expect(inferRemediationId(mismatch)).toBe("retry-recorded-source-path");
  });

  it("asks for --remote when several remotes exist and none is named origin", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.remoteOutput = "glab-base\nupstream\n";
    const error = await captureFailure(fixture, commands);
    expect(error.code).toBe("ambiguous-remote");
    expect(error.message).toMatch(/Pass --remote <name> on do, run, or publish/u);
    expect(error.message).toMatch(/selects origin/u);
    expect(inferRemediationId(error)).toBe("select-publication-remote");
    const printed = formatOperatorErrorEnvelope(toOperatorErrorEnvelope(error));
    expect(printed).toContain(remediationText("select-publication-remote"));
    expect(printed).not.toMatch(/glab auth login/iu);
  });

  it.each([
    ["main", "source-branch-is-default"],
    ["release/1.0", "source-branch-protected"],
    ["bad..branch", "unsafe-source-branch"],
  ])("rejects default, protected, and invalid source branch %s", async (source, code) => {
    const fixture = await createFixture();
    const error = await captureFailure(fixture, new FakeCommands(), source);
    expect(error.code).toBe(code);
  });

  it("rejects detached checkouts, missing Git identity, and ineligible patches", async () => {
    const fixture = await createFixture();
    const detached = new FakeCommands();
    const originalRun = detached.run.bind(detached);
    detached.run = async (command, args, cwd) =>
      command === "git" &&
      stripSafeGitConfig(args).join(" ") === "symbolic-ref --quiet --short HEAD"
        ? failed()
        : originalRun(command, args, cwd);
    expect((await captureFailure(fixture, detached)).code).toBe("detached-head");

    const identity = new FakeCommands();
    identity.gitName = "";
    identity.gitEmail = "";
    const glabPlan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      identity,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(glabPlan.identity.gitIdentitySha256).toBe(
      localUserGitIdentitySha256(identity.glabName, identity.glabEmail),
    );

    const malformedIdentity = new FakeCommands();
    malformedIdentity.gitName = "Maintainer\nInjected Identity\n";
    expect((await captureFailure(fixture, malformedIdentity)).code).toBe("git-identity-missing");

    const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    parsed.changes.files = [];
    await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, {
      mode: 0o600,
    });
    expect((await captureFailure(fixture, new FakeCommands())).code).toBe("patch-ineligible");
  });

  it("ignores a lagging local tracking ref when GitLab still names the write revision", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.trackingRevision = "b".repeat(40);
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      commands,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.baseRevision).toBe(REVISION);
  });

  it("does not infer npm run check from a tracked package.json check script", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.repository, "package.json"),
      `${JSON.stringify({ scripts: { check: "biome check ." } })}\n`,
    );
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.validationCommand).toBe(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND);
    expect(plan.documentationValidation?.validatorIdentity).toBe("docsfab-documentation-validator");
  });

  it("does not infer true from a mutating package.json check script", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.repository, "package.json"),
      `${JSON.stringify({ scripts: { check: "uv run ruff check src" } })}\n`,
    );
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(plan.validationCommand).toBe(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND);
    expect(plan.validationCommand).not.toBe("true");
  });

  it("binds explicit authorization to the exact reviewed plan", async () => {
    const fixture = await createFixture();
    const plan = await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      new FakeCommands(),
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
    expect(
      authorizeLocalUserPublication({
        plan,
        confirmedPlanSha256: plan.sha256,
        command: "publish",
      }),
    ).toEqual({
      schemaVersion: 1,
      kind: "docsfab-local-user-gitlab-publication-authorization",
      deliveryMode: "local-user",
      command: "publish",
      decision: "authorized",
      planSha256: plan.sha256,
    });
    try {
      authorizeLocalUserPublication({
        plan,
        confirmedPlanSha256: "b".repeat(64),
        command: "publish",
      });
      throw new Error("Expected authorization rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalUserPublicationPreflightError);
      expect((error as LocalUserPublicationPreflightError).code).toBe("invalid-input");
    }

    const tampered = { ...plan, proposedSourceBranch: "docsfab-run/tampered" };
    expect(() => serializeLocalUserPublicationPlan(tampered)).toThrow(
      LocalUserPublicationPreflightError,
    );
    expect(() =>
      authorizeLocalUserPublication({
        plan: tampered,
        confirmedPlanSha256: tampered.sha256,
        command: "publish",
      }),
    ).toThrow(LocalUserPublicationPreflightError);

    const injected = { ...plan, credential: SECRET };
    injected.sha256 = localUserPublicationPlanSha256(injected);
    expect(() => serializeLocalUserPublicationPlan(injected)).toThrow(
      LocalUserPublicationPreflightError,
    );

    const invalidIdentity = structuredClone(plan);
    invalidIdentity.identity.gitIdentitySha256 = "not-a-digest";
    invalidIdentity.sha256 = localUserPublicationPlanSha256(invalidIdentity);
    expect(() => serializeLocalUserPublicationPlan(invalidIdentity)).toThrow(
      LocalUserPublicationPreflightError,
    );
  });

  it("exposes sealed productOutcome disposition and codes on verified runs (#246)", async () => {
    const fixture = await createFixture();
    const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    const decoded = decodeSuccessfulPublicationRunRecord(parsed);
    const outcome = createWorkflowOutcome(
      defaultInconclusiveWorkflowOutcome(decoded),
      decoded,
      SECURITY_SCAN_POLICY,
    );
    parsed.workflowOutcome = outcome;
    await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, {
      mode: 0o600,
    });

    const run = await loadVerifiedPublicationRun(fixture.recordPath, "run-1", SECURITY_SCAN_POLICY);
    expect(run.workflowOutcome).toBe(getWorkflow("site-bootstrap").outcome);
    expect(run.productOutcome).toEqual(outcome);
    expect(run.productOutcome?.disposition).toBe("inconclusive");
    expect(run.productOutcome?.limitations).toContain("structured-product-evidence-unavailable");
    expect(run.productOutcome?.findings.map((finding) => finding.code)).toContain(
      "structured-product-evidence-unavailable",
    );
  });

  it("rejects a loose pseudo schema-v2 write record", async () => {
    const fixture = await createFixture();
    const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8"));
    delete parsed.workspace;
    delete parsed.createdAt;
    delete parsed.models;
    delete parsed.skills;
    delete parsed.usage;
    delete parsed.tools;
    delete parsed.steps[0].skill;
    await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, {
      mode: 0o600,
    });
    expect((await captureFailure(fixture, new FakeCommands())).code).toBe(
      "run-record-contract-gap",
    );
  });

  it("rejects denied scanner disposition and impossible timing, usage, model, and tool relations", async () => {
    const mutations: Array<(record: any) => void> = [
      (record) => {
        record.securityScan.status = "blocked";
        record.securityScan.findings = [{ path: "README.md", ruleId: "credential.token" }];
        record.securityScanEffectiveDisposition.status = "denied";
      },
      (record) => {
        record.durationMs = 999;
      },
      (record) => {
        record.usage.total = 1;
      },
      (record) => {
        record.models = [{ provider: "fake", model: "fabricated" }];
      },
      (record) => {
        record.tools.totalCalls = 1;
      },
      (record) => {
        record.securityScan = {
          ruleSet: "credential-rules-v1",
          status: "blocked",
          scannedFiles: 1,
          binaryFiles: 0,
          findings: [{ path: "README.md", ruleId: "credential-assigned-secret" }],
        };
        record.securityScanAuthorization = {
          status: "authorized",
          overrides: [
            {
              ruleId: "credential-assigned-secret",
              revision: REVISION,
              reason: "Maintainer reviewed the exact false positive.",
              expiresAt: "2026-08-05T00:00:00.000Z",
              decision: "authorized",
              findingCount: 2,
            },
          ],
        };
        record.securityScanEffectiveDisposition = { status: "authorized" };
      },
    ];
    for (const mutate of mutations) {
      const fixture = await createFixture();
      const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8"));
      mutate(parsed);
      await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, {
        mode: 0o600,
      });
      expect((await captureFailure(fixture, new FakeCommands())).code).toBe(
        "run-record-contract-gap",
      );
    }
  });
});

describe("run base GitLab cannot publish from (#2120)", () => {
  const TARGET = "b".repeat(40);
  // GitLab's real answers for a commit it does not have.
  const mergeBaseUnknownRef: ReadOnlyCommandResult = {
    exitCode: 1,
    stdout: '{"message":"Could not find ref"}',
    stderr: "glab: Could not find ref (HTTP 400)",
  };
  const commitNotFound: ReadOnlyCommandResult = {
    exitCode: 1,
    stdout: '{"message":"404 Commit Not Found"}',
    stderr: "glab: 404 Commit Not Found (HTTP 404)",
  };

  function preflight(fixture: Fixture, commands: FakeCommands) {
    return preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      commands,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
  }

  function commitProbes(commands: FakeCommands) {
    return commands.calls
      .filter(
        (call) => call.command === "glab" && /\/repository\/commits\//u.test(call.args[3] ?? ""),
      )
      .map((call) => call.args[3]);
  }

  it("refuses a run base that was never pushed with run-revision-unpushed and a push-first NEXT", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.branchRevision = TARGET;
    commands.mergeBaseFailure = mergeBaseUnknownRef;
    commands.commitProbe = commitNotFound;
    const error = await captureFailure(fixture, commands);
    expect(error).toBeInstanceOf(LocalUserPublicationPreflightError);
    expect(error.code).toBe("run-revision-unpushed");
    expect(error.message).toBe(
      `Local-user GitLab publication preflight failed (run-revision-unpushed). GitLab does not have the run base commit; it was never pushed. Push that commit to the target branch, then republish a preserved write with \`docsfab ship <run-id> --repo <path>\`; or start a new run from a commit that is already on the target branch. Run base ${REVISION}; GitLab target ${TARGET} (main).`,
    );
    expect(error.message).not.toContain("Republish a preserved write with");
    expect(error.message).not.toContain(SECRET);
    expect(commitProbes(commands)).toEqual([`projects/42/repository/commits/${REVISION}`]);
  });

  it("publishes once the base commit is pushed to the target branch, as the NEXT says", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.branchRevision = TARGET;
    commands.mergeBaseFailure = mergeBaseUnknownRef;
    commands.commitProbe = commitNotFound;
    expect((await captureFailure(fixture, commands)).code).toBe("run-revision-unpushed");

    // `git push origin <run-base>:main` fast-forwards GitLab's main to the run base.
    commands.mergeBaseFailure = undefined;
    commands.commitProbe = undefined;
    commands.branchRevision = REVISION;
    expect((await preflight(fixture, commands)).baseRevision).toBe(REVISION);

    // main moved on after the push: the run base is still its ancestor.
    commands.branchRevision = TARGET;
    commands.mergeBaseRevision = REVISION;
    expect((await preflight(fixture, commands)).baseRevision).toBe(REVISION);
  });

  it("publishes a run whose base is already on the default branch (control)", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    expect((await preflight(fixture, commands)).baseRevision).toBe(REVISION);
    expect(commitProbes(commands)).toEqual([]);
  });

  it("keeps stale-revision when GitLab has the run base but the target branch does not contain it", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.branchRevision = TARGET;
    commands.mergeBaseRevision = "c".repeat(40);
    const error = await captureFailure(fixture, commands);
    expect(error.code).toBe("stale-revision");
    expect(error.message).toContain(
      "The run base is not an ancestor of GitLab's target branch; for example, it is only on another branch, or the target-branch history was rewritten. Merge it into the target branch, then republish",
    );
    expect(error.message).toContain(`Run base ${REVISION}; GitLab target ${TARGET} (main).`);
    expect(error.message).not.toContain("never pushed");
    expect(commitProbes(commands)).toEqual([]);
  });

  it("keeps stale-revision when merge_base fails but GitLab has the run base commit", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.branchRevision = TARGET;
    commands.mergeBaseFailure = mergeBaseUnknownRef;
    commands.commitProbe = json({ id: REVISION });
    const error = await captureFailure(fixture, commands);
    expect(error.code).toBe("stale-revision");
    expect(error.message).toContain(`Run base ${REVISION}; GitLab target ${TARGET} (main).`);
  });

  it("keeps stale-revision when the commit lookup fails without a not-found answer", async () => {
    const fixture = await createFixture();
    const commands = new FakeCommands();
    commands.branchRevision = TARGET;
    commands.mergeBaseFailure = mergeBaseUnknownRef;
    const error = await captureFailure(fixture, commands);
    expect(error.code).toBe("stale-revision");
    expect(error.message).not.toContain(SECRET);
  });

  it.each([
    ["merge_base", "unreachable", "glab: dial tcp: i/o timeout", "gitlab-unreachable"],
    [
      "merge_base",
      "unauthenticated",
      "glab: 401 Unauthorized (HTTP 401)",
      "gitlab-unauthenticated",
    ],
    ["commit lookup", "unreachable", "glab: connection reset by peer", "gitlab-unreachable"],
    [
      "commit lookup",
      "unauthenticated",
      "glab: 401 Unauthorized (HTTP 401)",
      "gitlab-unauthenticated",
    ],
  ] as const)(
    "names GitLab as %s %s instead of blaming the run base",
    async (step, _label, stderr, code) => {
      const fixture = await createFixture();
      const commands = new FakeCommands();
      commands.branchRevision = TARGET;
      const failure: ReadOnlyCommandResult = { exitCode: 1, stdout: SECRET, stderr };
      commands.mergeBaseFailure = step === "merge_base" ? failure : mergeBaseUnknownRef;
      commands.commitProbe = step === "commit lookup" ? failure : commitNotFound;
      const error = await captureFailure(fixture, commands);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(SECRET);
      expect(commitProbes(commands)).toHaveLength(step === "merge_base" ? 0 : 1);
    },
  );
});

async function createFixture(): Promise<Fixture> {
  const root = await temporaryDirectories.create("docsfab-delivery-test-");
  const repository = join(root, "repository");
  const state = join(root, "state");
  await mkdir(repository);
  await mkdir(state);
  await writeFile(join(repository, "README.md"), "unchanged\n");
  const patchPath = join(state, "run-1.patch");
  const patch = Buffer.from("diff --git a/README.md b/README.md\n", "utf8");
  await writeFile(patchPath, patch, { mode: 0o600 });
  const recordPath = join(state, "run-1.json");
  await writeFile(
    recordPath,
    `${JSON.stringify({
      schemaVersion: 2,
      id: "run-1",
      workflow: "site-bootstrap",
      repository: {
        sourcePath: repository,
        requestedRevision: "HEAD",
        revision: REVISION,
      },
      workspace: { strategy: "tracked-export", disposable: true },
      task: {
        kind: "site-bootstrap",
        plan: {
          kind: "ia-plan",
          schemaVersion: 1,
          digest: "a".repeat(64),
          repositoryRevision: REVISION,
          repositoryContentDigest: "b".repeat(64),
        },
      },
      status: "succeeded",
      createdAt: "2026-08-04T00:00:00.000Z",
      startedAt: "2026-08-04T00:00:01.000Z",
      completedAt: "2026-08-04T00:00:02.000Z",
      durationMs: 1000,
      models: [],
      skills: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        turns: 0,
      },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      securityScan: {
        ruleSet: "credential-rules-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      },
      securityScanEffectiveDisposition: { status: "passed" },
      instruction: SECRET,
      artifacts: [
        {
          role: "input",
          stepId: "apply-site-bootstrap",
          reference: {
            kind: "ia-plan",
            schemaVersion: 1,
            digest: "a".repeat(64),
            repositoryRevision: REVISION,
            repositoryContentDigest: "b".repeat(64),
          },
        },
      ],
      steps: [
        {
          id: "apply-site-bootstrap",
          title: "Apply approved site bootstrap",
          kind: "host-operation",
          operation: "site-bootstrap",
          skill: "template-scaffold-site",
          mode: "write",
          status: "succeeded",
          startedAt: "2026-08-04T00:00:01.000Z",
          completedAt: "2026-08-04T00:00:02.000Z",
          durationMs: 1000,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
            turns: 0,
          },
          tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
          contextPreflight: {
            status: "ready",
            packetDigest: "c".repeat(64),
            consultedNodeIds: ["node-a"],
            ontologyVersion: "ontology-v1",
            effectiveDecisionIds: [],
            measurements: {
              byteLength: 1,
              estimatedTokens: 1,
              latencyMs: 0,
              nodeCount: 1,
              edgeCount: 0,
              pathCount: 1,
            },
            cache: {
              disposition: "miss",
              keyDigest: "d".repeat(64),
              rebuildAttempted: true,
            },
          },
          artifacts: [
            {
              role: "input",
              stepId: "apply-site-bootstrap",
              reference: {
                kind: "ia-plan",
                schemaVersion: 1,
                digest: "a".repeat(64),
                repositoryRevision: REVISION,
                repositoryContentDigest: "b".repeat(64),
              },
            },
          ],
          summary: "Applied approved site plan.",
        },
      ],
      changes: {
        files: [{ path: "README.md", status: "modified" }],
        patch: {
          sha256: createHash("sha256").update(patch).digest("hex"),
          byteLength: patch.byteLength,
          lineCount: 1,
          artifactPath: patchPath,
          format: "git-diff",
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  return { root, repository, recordPath, patchPath };
}

/** Replace the fixture's patch artifact and the digest the record binds to it. */
async function replacePatch(fixture: Fixture, text: string): Promise<void> {
  const patch = Buffer.from(text, "utf8");
  await writeFile(fixture.patchPath, patch, { mode: 0o600 });
  const parsed = JSON.parse(await readFile(fixture.recordPath, "utf8"));
  parsed.changes.patch.sha256 = createHash("sha256").update(patch).digest("hex");
  parsed.changes.patch.byteLength = patch.byteLength;
  parsed.changes.patch.lineCount = text.split("\n").length - 1;
  await writeFile(fixture.recordPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
}

describe("preflight checks the effective Git configuration with the publisher's policy (#2363)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const HOME = "/operator-test-home";
  const LOCAL = "file:.git/config";
  const GLOBAL = `file:${HOME}/.gitconfig`;
  const entry = (origin: string, key: string, value: string): string =>
    `${origin}\0${key}\n${value}\0`;
  /** The environment the host publisher's Git runs with, and what must not reach its configuration read. */
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME,
    USER: "operator",
    LOGNAME: "operator",
    SSH_AUTH_SOCK: "/run/docsfab-test/agent.sock",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: "attacker",
    GLAB_TOKEN: SECRET,
  };

  async function plan(commands: FakeCommands, context: LocalUserPublicationPreflightContext = {}) {
    const fixture = await createFixture();
    return preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        draftMergeRequest: true,
      },
      commands,
      {},
      { ...CHECKOUT_CANDIDATE_CONTEXT, ...context },
    );
  }

  async function failure(
    commands: FakeCommands,
    context: LocalUserPublicationPreflightContext = {},
  ): Promise<LocalUserPublicationPreflightError> {
    return plan(commands, context).then(
      () => {
        throw new Error("Expected preflight failure.");
      },
      (error: unknown) => error as LocalUserPublicationPreflightError,
    );
  }

  const configurationRead = (call: { args: readonly string[] }) =>
    call.args.includes("--show-origin");

  it("refuses a setting the publisher refuses, naming it and its file, before any GitLab call", async () => {
    const commands = new FakeCommands();
    commands.effectiveConfigList = [
      entry(GLOBAL, "user.name", "Operator"),
      entry(LOCAL, "core.sshcommand", `ssh -i /tmp/${SECRET}`),
    ].join("");
    const error = await failure(commands, { environment });
    expect(error.code).toBe("git-configuration-refused");
    expect(error.details?.configuration).toEqual({ key: "core.sshcommand", origin: LOCAL });
    expect(error.message).toContain("The setting core.sshcommand comes from file:.git/config.");
    // Never the value, the home directory, or a credential.
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(HOME);
    // The refusal is local: no GitLab call was made, so it costs no network and no model.
    expect(commands.calls.filter((call) => call.command === "glab")).toEqual([]);
    expect(commands.calls.filter((call) => configurationRead(call))).toHaveLength(1);
    // Its next action is the remediation, not the doctor fallback.
    expect(toOperatorErrorEnvelope(error).nextAction).toBe(
      remediationText("remove-refused-git-setting"),
    );
    expect(inferRemediationId(error)).toBe("remove-refused-git-setting");
  });

  it.each([
    ["a global core.sshCommand", entry(GLOBAL, "core.sshcommand", "ssh -i /operator/.ssh/work")],
    ["a global core.askPass", entry(GLOBAL, "core.askpass", "/usr/bin/ssh-askpass")],
    ["signing turned off in the checkout", entry(LOCAL, "commit.gpgsign", "false")],
    ["tag signing turned off in the checkout", entry(LOCAL, "tag.gpgsign", "off")],
    ["a global signing key", entry(GLOBAL, "user.signingkey", "ABCD")],
    ["a plain global credential helper", entry(GLOBAL, "credential.helper", "osxkeychain")],
    [
      "a checkout credential helper for another host",
      entry(LOCAL, "credential.https://other.example.test.helper", "!/tmp/steal"),
    ],
  ])("accepts %s, as the publisher does", async (_label, listing) => {
    const commands = new FakeCommands();
    commands.effectiveConfigList = listing;
    const result = await plan(commands, { environment });
    expect(result.checks.repository).toBe("passed");
  });

  it.each([
    ["signing turned on in the checkout", entry(LOCAL, "commit.gpgsign", "true"), "commit.gpgsign"],
    ["a checkout core.askPass", entry(LOCAL, "core.askpass", "/tmp/askpass"), "core.askpass"],
    [
      "a global core.hooksPath",
      entry(GLOBAL, "core.hookspath", "/operator/hooks"),
      "core.hookspath",
    ],
    [
      "a global http.<url>.extraHeader",
      entry(GLOBAL, "http.https://gitlab.example.test/.extraheader", "X-Extra: 1"),
      "http.*.extraheader",
    ],
    [
      "a checkout URL rewrite that carries a credential",
      entry(
        LOCAL,
        `url.https://oauth2:${SECRET}@gitlab.example.test/.insteadof`,
        "https://gitlab.example.test/",
      ),
      "url.*.insteadof",
    ],
    [
      "an executable credential helper for the selected host",
      entry(GLOBAL, "credential.https://gitlab.example.test.helper", "!/tmp/steal"),
      "credential.*.helper",
    ],
    [
      "a plain credential helper in the checkout",
      entry(LOCAL, "credential.helper", "store"),
      "credential.helper",
    ],
    ["an include in the checkout", entry(LOCAL, "include.path", "/tmp/extra"), "include.path"],
  ])("refuses %s, as the publisher does", async (_label, listing, setting) => {
    const commands = new FakeCommands();
    commands.effectiveConfigList = listing;
    const error = await failure(commands, { environment });
    expect(error.code).toBe("git-configuration-refused");
    expect(error.details?.configuration?.key).toBe(setting);
    expect(error.message).not.toContain(SECRET);
  });

  it("shortens the operator's home directory to ~ in the file it names", async () => {
    const commands = new FakeCommands();
    commands.effectiveConfigList = entry(GLOBAL, "core.hookspath", "/operator/hooks");
    const error = await failure(commands, { environment });
    expect(error.details?.configuration?.origin).toBe("file:~/.gitconfig");
    expect(error.message).toContain("The setting core.hookspath comes from file:~/.gitconfig.");
    expect(error.message).not.toContain(HOME);
  });

  it("trusts the global files of the HOME the publisher's Git will run with", async () => {
    // The same listing is the operator's own file under that HOME and an untrusted file under another.
    const listing = entry(GLOBAL, "core.sshcommand", "ssh");
    const own = new FakeCommands();
    own.effectiveConfigList = listing;
    await expect(plan(own, { environment })).resolves.toMatchObject({ run: { id: "run-1" } });
    const other = new FakeCommands();
    other.effectiveConfigList = listing;
    await expect(
      failure(other, { environment: { ...environment, HOME: "/another-home" } }),
    ).resolves.toMatchObject({ code: "git-configuration-refused" });
  });

  it("reads the configuration with the publisher's Git environment and flags, and nothing it does not need", async () => {
    const commands = new FakeCommands();
    await plan(commands, { environment });
    const reads = commands.calls.filter(
      (call) => call.command === "git" && configurationRead(call),
    );
    expect(reads).toHaveLength(1);
    const read = reads[0]!;
    expect(stripSafeGitConfig(read.args)).toEqual([
      "config",
      "--includes",
      "--show-origin",
      "--null",
      "--list",
    ]);
    // The publisher's own -c overrides lead the read, so their entries match the publisher's.
    expect(read.args.slice(0, 4)).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
    ]);
    expect(read.args).toContain("commit.gpgSign=false");
    expect(read.args).toContain("protocol.https.allow=always");
    expect(read.options?.env).toMatchObject({
      HOME,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    // Not the agent socket, the login names, ambient Git configuration, or a token.
    for (const name of [
      "SSH_AUTH_SOCK",
      "USER",
      "LOGNAME",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GLAB_TOKEN",
    ]) {
      expect(read.options?.env?.[name], name).toBeUndefined();
    }
    // The identity read takes the same environment, so one HOME binds and checks.
    const identity = commands.calls.find(
      (call) => call.command === "git" && call.args.at(-1) === "user.name",
    );
    expect(identity?.options?.env?.HOME).toBe(HOME);
  });

  it("reads the listing under the declared output bound, which a host override moves, and no other Git read under it", async () => {
    const commands = new FakeCommands();
    await plan(commands, { environment });
    const reads = commands.calls.filter((call) => call.command === "git");
    const listing = reads.filter((call) => configurationRead(call));
    expect(listing).toHaveLength(1);
    expect(listing[0]!.options?.maxOutputBytes).toBe(limit(GIT_CONFIGURATION_LISTING_LIMIT).value);
    // The other Git reads keep the runner's own bound.
    expect(
      reads.filter((call) => !configurationRead(call)).map((call) => call.options?.maxOutputBytes),
    ).not.toContain(limit(GIT_CONFIGURATION_LISTING_LIMIT).value);

    vi.stubEnv("DOCSFAB_DELIVERY_GIT_CONFIGURATION_LISTING_MAX_BYTES", "4096");
    const lowered = new FakeCommands();
    await plan(lowered, { environment });
    expect(
      lowered.calls.find((call) => call.command === "git" && configurationRead(call))?.options
        ?.maxOutputBytes,
    ).toBe(4096);
  });

  it("reports a listing stopped at the output bound as git-checkout-unverified and names the limit", async () => {
    const commands = new FakeCommands();
    commands.effectiveConfigExit = 1;
    commands.effectiveConfigFailure = "output-limit";
    // The runner hands back the prefix it read. It parses and holds nothing refused, so only
    // the failure marker tells that the listing is incomplete and a setting may lie beyond it.
    commands.effectiveConfigList = entry(GLOBAL, "user.name", "Operator");
    const error = await failure(commands, { environment });
    expect(error.code).toBe("git-checkout-unverified");
    expect(error.details?.limitRefusal).toContain(
      "delivery-git-configuration-listing-max-bytes-bound: exceeded delivery.gitConfigurationListingMaxBytes = 2097152 bytes.",
    );
    expect(error.message).toContain("DOCSFAB_DELIVERY_GIT_CONFIGURATION_LISTING_MAX_BYTES");
    expect(commands.calls.filter((call) => call.command === "glab")).toEqual([]);

    // Positive controls: a read that fails, or times out, for another reason names no limit.
    for (const stopped of [undefined, "timeout"] as const) {
      const other = new FakeCommands();
      other.effectiveConfigExit = 1;
      if (stopped) other.effectiveConfigFailure = stopped;
      const unverified = await failure(other, { environment });
      expect(unverified.code).toBe("git-checkout-unverified");
      expect(unverified.details).toBeUndefined();
      expect(unverified.message).not.toContain(
        "delivery-git-configuration-listing-max-bytes-bound",
      );
    }
  });

  describe("a HOME that is not the operator's own", () => {
    const sshCommand = (home: string) => entry(`file:${home}/.gitconfig`, "core.sshcommand", "ssh");

    it.each(["~", ".", "home"])(
      "refuses a global core.sshCommand under the relative HOME %s and says why",
      async (home) => {
        const commands = new FakeCommands();
        commands.effectiveConfigList = sshCommand(home);
        const error = await failure(commands, { environment: { ...environment, HOME: home } });
        expect(error.code).toBe("git-configuration-refused");
        expect(error.details?.configuration).toEqual({
          key: "core.sshcommand",
          origin: `file:${home}/.gitconfig`,
          reason: "home-not-operator-owned",
        });
        expect(error.message).toContain(
          "DocsFab does not trust that file for this setting because HOME is not an absolute path outside the checkout.",
        );
        // Positive control: the operator's own absolute HOME is accepted.
        const own = new FakeCommands();
        own.effectiveConfigList = sshCommand(HOME);
        await expect(plan(own, { environment })).resolves.toMatchObject({ run: { id: "run-1" } });
      },
    );

    it("refuses it under a HOME inside the checkout, however that HOME is written", async () => {
      const fixture = await createFixture();
      const inside = join(fixture.repository, "home");
      await mkdir(inside);
      const resolved = await realpath(fixture.repository);
      await symlink(inside, join(fixture.root, "home-link"));
      const asked = async (home: string) => {
        const commands = new FakeCommands();
        commands.effectiveConfigList = sshCommand(home);
        return preflightLocalUserGitLabPublication(
          {
            runId: "run-1",
            runRecordPath: fixture.recordPath,
            repositoryPath: fixture.repository,
            draftMergeRequest: true,
          },
          commands,
          {},
          { ...CHECKOUT_CANDIDATE_CONTEXT, environment: { ...environment, HOME: home } },
        ).then(
          () => undefined,
          (caught: unknown) => caught as LocalUserPublicationPreflightError,
        );
      };
      // The checkout itself and a directory in it, as the caller named the checkout and as it
      // resolves, and a link that leads into it.
      for (const home of [
        fixture.repository,
        inside,
        resolved,
        join(resolved, "home"),
        join(fixture.root, "home-link"),
      ]) {
        const error = await asked(home);
        expect(error?.code, home).toBe("git-configuration-refused");
        expect(error?.details?.configuration?.reason, home).toBe("home-not-operator-owned");
      }
      // Positive control: a HOME beside the checkout, not inside it, is the operator's own.
      expect(await asked(fixture.root)).toBeUndefined();
    });

    it("still accepts the inert settings that a global file under such a HOME holds", async () => {
      const commands = new FakeCommands();
      commands.effectiveConfigList = entry("file:~/.gitconfig", "commit.gpgsign", "true");
      await expect(
        plan(commands, { environment: { ...environment, HOME: "~" } }),
      ).resolves.toMatchObject({ run: { id: "run-1" } });
    });
  });

  it.each([
    ["an include", "include.path\n/tmp/extra\0"],
    ["an includeIf", "includeif.gitdir:/a\u2028b/.path\n/tmp/extra\0"],
    [
      "an includeIf, with a U+2029 in the condition",
      "includeif.gitdir:/a\u2029b/.path\n/tmp/extra\0",
    ],
    [
      "an includeIf, with a carriage return in the condition",
      "includeif.gitdir:/a\rb/.path\n/tmp/extra\0",
    ],
    ["an external diff command", "diff.a\u2028b.command\n/tmp/diff\0"],
    ["a filter", "filter.a\u2028b.smudge\n/tmp/filter\0"],
  ])(
    "refuses %s in the checkout's own configuration as unsafe-git-configuration, whatever its subsection holds",
    async (_label, local) => {
      const commands = new FakeCommands();
      commands.localConfigList = local;
      expect((await failure(commands, { environment })).code).toBe("unsafe-git-configuration");
      // Positive control: a setting outside those rules passes the check.
      const clean = new FakeCommands();
      clean.localConfigList = "user.name\nOperator\0";
      await expect(plan(clean, { environment })).resolves.toMatchObject({ run: { id: "run-1" } });
    },
  );

  it("falls back to the process environment when the context names none", async () => {
    const commands = new FakeCommands();
    await plan(commands);
    const read = commands.calls.find((call) => call.command === "git" && configurationRead(call));
    expect(read?.options?.env?.HOME).toBe(process.env.HOME);
  });

  it.each([
    ["exits with an error and prints nothing", { effectiveConfigExit: 1 }],
    [
      "exits with an error after printing a listing that parses",
      { effectiveConfigExit: 1, effectiveConfigList: entry(GLOBAL, "user.name", "Operator") },
    ],
    ["prints a key with no value", { effectiveConfigList: `${LOCAL}\0core.foo\0` }],
    ["prints an odd field", { effectiveConfigList: `${LOCAL}\0` }],
  ] as const)(
    "reports a configuration read that %s as git-checkout-unverified, before any GitLab call",
    async (_label, fault) => {
      const commands = Object.assign(new FakeCommands(), fault);
      const error = await failure(commands, { environment });
      expect(error.code).toBe("git-checkout-unverified");
      expect(error.details).toBeUndefined();
      expect(commands.calls.filter((call) => call.command === "glab")).toEqual([]);
      expect(toOperatorErrorEnvelope(error).nextAction).toBe(
        remediationText("repair-git-checkout"),
      );
    },
  );

  it("still reports hooks, includes, and filters in the checkout's own configuration as unsafe-git-configuration, first", async () => {
    // Positive control for the ordering: the local executable-configuration check is unchanged
    // and runs before the effective read, so its code and its read-count are unchanged.
    const commands = new FakeCommands();
    commands.localConfigList = "core.hooksPath\n.hooks\0";
    commands.effectiveConfigList = entry(LOCAL, "core.hookspath", ".hooks");
    const error = await failure(commands, { environment });
    expect(error.code).toBe("unsafe-git-configuration");
    expect(commands.calls.filter((call) => configurationRead(call))).toEqual([]);
  });
});

describe("one output bound, counted in bytes by both Git readers (#2363)", () => {
  const roots = temporaryRoots();

  /** A `git` that prints a file's bytes, so that either runner can be given a known output size. */
  async function fakeGit(content: string): Promise<NodeJS.ProcessEnv> {
    const directory = await roots.create("docsfab-output-bound-");
    await writeFile(join(directory, "output"), content);
    await writeFile(join(directory, "git"), '#!/bin/sh\n/bin/cat "$FAKE_GIT_OUTPUT"\n');
    await chmod(join(directory, "git"), 0o755);
    return { PATH: directory, FAKE_GIT_OUTPUT: join(directory, "output") };
  }

  async function bothReaders(content: string, maxOutputBytes: number) {
    const env = await fakeGit(content);
    const preflight = await new ExecFileReadOnlyCommandRunner().run("git", [], process.cwd(), {
      env,
      maxOutputBytes,
    });
    const publisher = await new ExecFileGitPublisherCommandRunner().run("git", [], process.cwd(), {
      env,
      timeoutMs: 20_000,
      maxOutputBytes,
    });
    return { preflight, publisher };
  }

  it.each([
    ["ASCII", "a", 1],
    ["a three-byte character", "\u20ac", 3],
  ] as const)(
    "admits %s up to the bound and stops it one byte past, in both",
    async (_label, unit, width) => {
      const characters = 40;
      const content = unit.repeat(characters);
      const bytes = characters * width;
      // At the bound the output fits; one byte under it, it does not. For the three-byte character
      // the character count (40) is far below the bound (119), so only a count of bytes stops it.
      for (const [bound, fits] of [
        [bytes, true],
        [bytes + 1, true],
        [bytes - 1, false],
      ] as const) {
        const { preflight, publisher } = await bothReaders(content, bound);
        expect(preflight.failure === "output-limit", `preflight at ${bound}`).toBe(!fits);
        expect(preflight.exitCode, `preflight at ${bound}`).toBe(fits ? 0 : 1);
        expect(publisher.exitCode, `publisher at ${bound}`).toBe(fits ? 0 : 1);
        if (fits) {
          expect(preflight.stdout).toBe(content);
          expect(publisher.stdout.toString("utf8")).toBe(content);
        }
      }
    },
  );

  it("leaves a Git read without a bound to the runner's own default", async () => {
    const env = await fakeGit("a".repeat(1000));
    const result = await new ExecFileReadOnlyCommandRunner().run("git", [], process.cwd(), { env });
    expect(result).toMatchObject({ exitCode: 0, stdout: "a".repeat(1000) });
    expect(result.failure).toBeUndefined();
  });

  it("dispatches gh through the same bounded process seam with caller output overrides", async () => {
    const directory = await roots.create("docsfab-gh-output-bound-");
    const output = join(directory, "output");
    await writeFile(output, "synthetic-token\n");
    await writeFile(join(directory, "gh"), '#!/bin/sh\n/bin/cat "$FAKE_GH_OUTPUT"\n');
    await chmod(join(directory, "gh"), 0o755);
    const env = { PATH: directory, FAKE_GH_OUTPUT: output };
    const runner = new ExecFileReadOnlyCommandRunner();
    const bytes = Buffer.byteLength("synthetic-token\n");
    const within = await runner.run("gh", ["auth", "token"], process.cwd(), {
      env,
      maxOutputBytes: bytes,
    });
    expect(within).toMatchObject({ exitCode: 0, stdout: "synthetic-token\n" });
    const exceeded = await runner.run("gh", ["auth", "token"], process.cwd(), {
      env,
      maxOutputBytes: bytes - 1,
    });
    expect(exceeded).toMatchObject({ exitCode: 1, failure: "output-limit" });
    expect(limit("delivery.readOnlyCommandTimeoutMs").value).toBe(
      LIMIT_DEFINITION_BY_NAME["delivery.readOnlyCommandTimeoutMs"]!.value,
    );
    expect(limit("delivery.readOnlyCommandMaxBufferBytes").value).toBe(
      LIMIT_DEFINITION_BY_NAME["delivery.readOnlyCommandMaxBufferBytes"]!.value,
    );
  });

  it("keeps the former default output ceiling at the catalog bound", async () => {
    const directory = await roots.create("docsfab-gh-default-bound-");
    const output = join(directory, "output");
    await writeFile(join(directory, "gh"), '#!/bin/sh\n/bin/cat "$FAKE_GH_OUTPUT"\n');
    await chmod(join(directory, "gh"), 0o755);
    const env = { PATH: directory, FAKE_GH_OUTPUT: output };
    const bound = limit("delivery.readOnlyCommandMaxBufferBytes").value;
    const runner = new ExecFileReadOnlyCommandRunner();
    await writeFile(output, "x".repeat(bound));
    const within = await runner.run("gh", ["auth", "token"], process.cwd(), { env });
    expect(within).toMatchObject({ exitCode: 0 });
    expect(Buffer.byteLength(within.stdout)).toBe(bound);
    await writeFile(output, "x".repeat(bound + 1));
    const exceeded = await runner.run("gh", ["auth", "token"], process.cwd(), { env });
    expect(exceeded).toMatchObject({ exitCode: 1, failure: "output-limit" });
  });

  it("uses the catalog timeout override for the read-only process", async () => {
    const directory = await roots.create("docsfab-gh-timeout-bound-");
    await writeFile(join(directory, "gh"), "#!/bin/sh\n/bin/sleep 1\n");
    await chmod(join(directory, "gh"), 0o755);
    vi.stubEnv("DOCSFAB_DELIVERY_READ_ONLY_COMMAND_TIMEOUT_MS", "100");
    try {
      const stopped = await new ExecFileReadOnlyCommandRunner().run(
        "gh",
        ["auth", "token"],
        process.cwd(),
        { env: { PATH: directory } },
      );
      expect(stopped).toMatchObject({ exitCode: 1 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

async function captureFailure(
  fixture: Fixture,
  commands: FakeCommands,
  proposedSourceBranch?: string,
): Promise<LocalUserPublicationPreflightError> {
  try {
    await preflightLocalUserGitLabPublication(
      {
        runId: "run-1",
        runRecordPath: fixture.recordPath,
        repositoryPath: fixture.repository,
        ...(proposedSourceBranch ? { proposedSourceBranch } : {}),
        draftMergeRequest: true,
      },
      commands,
      {},
      CHECKOUT_CANDIDATE_CONTEXT,
    );
  } catch (error) {
    return error as LocalUserPublicationPreflightError;
  }
  throw new Error("Expected preflight failure.");
}

function ok(stdout: string): ReadOnlyCommandResult {
  return { exitCode: 0, stdout };
}

function failed(): ReadOnlyCommandResult {
  return { exitCode: 1, stdout: SECRET };
}

function json(value: unknown): ReadOnlyCommandResult {
  return ok(`${JSON.stringify(value)}\n`);
}

function graphqlRawField(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-f" && args[index + 1]?.startsWith(`${name}=`)) {
      return args[index + 1]!.slice(name.length + 1);
    }
  }
  return undefined;
}

function readOnlyCall(call: { command: string; args: readonly string[] }): boolean {
  if (call.command === "git") {
    return !call.args.some((argument) =>
      [
        "add",
        "branch",
        "checkout",
        "commit",
        "fetch",
        "merge",
        "push",
        "reset",
        "switch",
        "worktree",
      ].includes(argument),
    );
  }
  return !call.args.some((argument) =>
    ["POST", "PUT", "PATCH", "DELETE", "mr", "create"].includes(argument),
  );
}

async function directorySnapshot(repository: string): Promise<string[]> {
  return (await readdir(repository)).sort();
}
