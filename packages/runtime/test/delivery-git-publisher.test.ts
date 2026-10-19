// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { limit } from "../src/config/limits.js";
import { GIT_CONFIGURATION_LISTING_LIMIT } from "../src/delivery/git-config-policy.js";
import {
  DeterministicLocalGitPublisher,
  ExecFileGitPublisherCommandRunner,
  GitPublisherError,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  type DeliveryWorktreeReadyAttestation,
  type GitPublisherCommandResult,
  type GitPublisherCommandRunner,
  type LocalUserPublicationPlanV1,
} from "../src/delivery/index.js";
import { commitFixture, git, hermeticGitEnv } from "./helpers/git.js";

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

class FakeCommands implements GitPublisherCommandRunner {
  public readonly calls: string[][] = [];
  public readonly environments: NodeJS.ProcessEnv[] = [];
  /** The output bound each call was given, by call. */
  public readonly bounds: Array<{ call: string; maxOutputBytes: number }> = [];
  public name = "Maintainer";
  public email = "maintainer@example.test";
  public remote?: string;
  public pushExit = 0;
  public config = "";
  /**
   * While set, the configuration listing fails with this exit status but still hands back what it
   * printed, as the real runner does when it stops a listing at the output bound.
   */
  public configExit = 0;
  public version = "git version 2.50.1 (Apple Git-155)\n";
  /** While set, `git version` itself fails, as an Apple Git does when a global file is malformed. */
  public versionExit = 0;
  public fetchUrl = "git@gitlab.example.test:group/docs.git";
  public pushUrl = "git@gitlab.example.test:group/docs.git";

  public async run(
    _command: "git",
    args: readonly string[],
    _cwd: string,
    options: { env: NodeJS.ProcessEnv; maxOutputBytes: number },
  ): Promise<GitPublisherCommandResult> {
    this.environments.push(options.env);
    const call = stripConfig(args);
    this.calls.push([...call]);
    const key = call.join(" ");
    this.bounds.push({ call: key, maxOutputBytes: options.maxOutputBytes });
    if (key === "version") {
      // A failing `git version` may still have printed a version: only the exit status says.
      return { exitCode: this.versionExit, stdout: Buffer.from(this.version) };
    }
    if (key === "config --includes --show-origin --null --list") {
      return { exitCode: this.configExit, stdout: Buffer.from(this.config) };
    }
    if (key === "config --get user.name") return this.name ? ok(`${this.name}\n`) : failed();
    if (key === "config --get user.email") return this.email ? ok(`${this.email}\n`) : failed();
    if (key === "remote get-url --all origin") return ok(`${this.fetchUrl}\n`);
    if (key === "remote get-url --push --all origin") return ok(`${this.pushUrl}\n`);
    if (key === `rev-parse --verify refs/heads/docsfab-run/run-1^{commit}`)
      return ok(`${COMMIT}\n`);
    if (key.startsWith("ls-remote --heads --refs git@gitlab.example.test:group/docs.git ")) {
      return this.remote ? ok(`${this.remote}\trefs/heads/docsfab-run/run-1\n`) : ok("");
    }
    if (call[0] === "push") {
      if (this.pushExit === 0) {
        this.remote = call.at(-1) === ":refs/heads/docsfab-run/run-1" ? undefined : COMMIT;
      }
      return this.pushExit === 0 ? ok("push accepted\n") : failed();
    }
    return failed();
  }
}

describe("deterministic local Git publisher", () => {
  it("uses one atomic empty-expected create lease and disables extra push effects", async () => {
    const commands = new FakeCommands();
    commands.fetchUrl = "https://gitlab.example.test/group/docs.git";
    const publisher = new DeterministicLocalGitPublisher(commands, {
      HOME: "/operator",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/private/agent",
      GIT_CONFIG_COUNT: "99",
      GIT_SSH_COMMAND: "malicious",
    });
    let authorizationChecks = 0;
    expect(
      await publisher.ensurePush({
        plan: plan(),
        commitRevision: COMMIT,
        cwd: "/delivery",
        assertAuthorized: () => {
          authorizationChecks += 1;
        },
      }),
    ).toBe(COMMIT);
    expect(authorizationChecks).toBe(1);
    const push = commands.calls.find((call) => call[0] === "push")!;
    expect(push).toEqual([
      "push",
      "--porcelain",
      "--no-verify",
      "--no-signed",
      "--no-recurse-submodules",
      "--no-follow-tags",
      "--no-tags",
      "--no-prune",
      "--no-mirror",
      "--no-all",
      "--no-delete",
      "--no-set-upstream",
      "--no-push-option",
      "--force-with-lease=refs/heads/docsfab-run/run-1:",
      "git@gitlab.example.test:group/docs.git",
      `${COMMIT}:refs/heads/docsfab-run/run-1`,
    ]);
    expect(push).not.toContain("--force");
    expect(push.filter((argument) => argument.includes(":refs/heads/"))).toHaveLength(1);
  });

  it("reobserves lease rejection and accepts only an exact concurrent creator", async () => {
    const commands = new FakeCommands();
    commands.pushExit = 1;
    let observations = 0;
    const original = commands.run.bind(commands);
    commands.run = async (command, args, cwd, options) => {
      const stripped = stripConfig(args);
      if (stripped[0] === "ls-remote") {
        observations += 1;
        if (observations >= 2) commands.remote = COMMIT;
      }
      return original(command, args, cwd, options);
    };
    const publisher = new DeterministicLocalGitPublisher(commands, { HOME: "/operator" });
    await expect(
      publisher.ensurePush({ plan: plan(), commitRevision: COMMIT, cwd: "/delivery" }),
    ).resolves.toBe(COMMIT);

    const conflict = new FakeCommands();
    conflict.pushExit = 1;
    let conflictObservations = 0;
    const conflictOriginal = conflict.run.bind(conflict);
    conflict.run = async (command, args, cwd, options) => {
      if (stripConfig(args)[0] === "ls-remote" && ++conflictObservations >= 2) {
        conflict.remote = "c".repeat(40);
      }
      return conflictOriginal(command, args, cwd, options);
    };
    await expect(
      new DeterministicLocalGitPublisher(conflict, { HOME: "/operator" }).ensurePush({
        plan: plan(),
        commitRevision: COMMIT,
        cwd: "/delivery",
      }),
    ).rejects.toMatchObject({ code: "remote-branch-conflict" });
  });

  it("deletes only an exact remote revision through the pinned publication adapter", async () => {
    const commands = new FakeCommands();
    commands.remote = COMMIT;
    const publisher = new DeterministicLocalGitPublisher(commands, {
      HOME: "/operator",
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "remote.origin.receivepack",
      GIT_CONFIG_VALUE_0: "malicious",
    });
    await publisher.deleteRemoteBranch({
      target: {
        project: { host: "gitlab.example.test", path: "group/docs" },
        remote: { name: "origin", transport: "ssh" },
      },
      branch: "docsfab-run/run-1",
      expectedRevision: COMMIT,
      cwd: "/delivery",
    });
    expect(commands.remote).toBeUndefined();
    expect(
      commands.environments.every(
        (environment) =>
          environment.GIT_CONFIG_COUNT === undefined &&
          environment.GIT_CONFIG_KEY_0 === undefined &&
          environment.GIT_CONFIG_VALUE_0 === undefined,
      ),
    ).toBe(true);
    expect(commands.calls.find((call) => call[0] === "push")).toEqual([
      "push",
      "--porcelain",
      "--no-verify",
      "--no-signed",
      "--no-recurse-submodules",
      "--no-follow-tags",
      "--no-tags",
      "--no-prune",
      "--no-mirror",
      "--no-all",
      "--no-set-upstream",
      "--no-push-option",
      `--force-with-lease=refs/heads/docsfab-run/run-1:${COMMIT}`,
      "git@gitlab.example.test:group/docs.git",
      ":refs/heads/docsfab-run/run-1",
    ]);

    const conflict = new FakeCommands();
    conflict.remote = "c".repeat(40);
    await expect(
      new DeterministicLocalGitPublisher(conflict, { HOME: "/operator" }).deleteRemoteBranch({
        target: {
          project: { host: "gitlab.example.test", path: "group/docs" },
          remote: { name: "origin", transport: "ssh" },
        },
        branch: "docsfab-run/run-1",
        expectedRevision: COMMIT,
        cwd: "/delivery",
      }),
    ).rejects.toMatchObject({ code: "remote-branch-conflict" });

    const unsafe = new FakeCommands();
    unsafe.remote = COMMIT;
    unsafe.config = "file:/delivery/.git/config\0remote.origin.receivepack\nmalicious\0";
    await expect(
      new DeterministicLocalGitPublisher(unsafe, { HOME: "/operator" }).deleteRemoteBranch({
        target: {
          project: { host: "gitlab.example.test", path: "group/docs" },
          remote: { name: "origin", transport: "ssh" },
        },
        branch: "docsfab-run/run-1",
        expectedRevision: COMMIT,
        cwd: "/delivery",
      }),
    ).rejects.toMatchObject({ code: "refused-configuration" });
    expect(unsafe.calls.some((call) => call[0] === "push")).toBe(false);
  });

  it("rejects stale identity, old Git, remote drift, and local executable credential config", async () => {
    const cases: Array<(commands: FakeCommands) => void> = [
      (commands) => {
        commands.name = "Impersonator";
      },
      (commands) => {
        commands.version = "git version 2.9.4\n";
      },
      (commands) => {
        commands.config = "file:/delivery/.git/config\0credential.helper\n!malicious\0";
      },
    ];
    for (const mutate of cases) {
      const commands = new FakeCommands();
      mutate(commands);
      await expect(
        new DeterministicLocalGitPublisher(commands, {
          HOME: "/operator",
        }).assertConfiguredIdentity(plan(), "/delivery"),
      ).rejects.toBeInstanceOf(GitPublisherError);
    }
  });

  describe("Git configuration through the shared policy (#2363)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const HOME = "/operator";
    const GLOBAL = `file:${HOME}/.gitconfig`;
    const LOCAL = "file:/delivery/.git/config";
    const entry = (origin: string, key: string, value: string): string =>
      `${origin}\0${key}\n${value}\0`;

    async function verify(config: string) {
      const commands = new FakeCommands();
      commands.config = config;
      await new DeterministicLocalGitPublisher(commands, {
        HOME,
      }).assertConfiguredIdentity(plan(), "/delivery");
    }

    it.each([
      ["signing turned off in the checkout", entry(LOCAL, "commit.gpgsign", "false")],
      ["tag signing turned off in the checkout", entry(LOCAL, "tag.gpgsign", "off")],
      ["a global core.sshCommand", entry(GLOBAL, "core.sshcommand", "ssh -i /operator/.ssh/work")],
      ["a global core.askPass", entry(GLOBAL, "core.askpass", "/usr/bin/ssh-askpass")],
      [
        "an executable credential helper scoped to another host",
        entry(LOCAL, "credential.https://other.example.test.helper", "!/tmp/steal"),
      ],
      [
        "the host's own -c overrides",
        [
          entry("command line:", "core.hookspath", "/dev/null"),
          entry("command line:", "core.fsmonitor", "false"),
          entry("command line:", "commit.gpgsign", "false"),
          entry("command line:", "tag.gpgsign", "false"),
        ].join(""),
      ],
    ])("accepts %s", async (_label, config) => {
      await expect(verify(config)).resolves.toBeUndefined();
    });

    it.each([
      ["signing turned on in the checkout", entry(LOCAL, "commit.gpgsign", "true")],
      ["a checkout core.sshCommand", entry(LOCAL, "core.sshcommand", "ssh -i /tmp/key")],
      ["a checkout core.askPass", entry(LOCAL, "core.askpass", "/tmp/askpass")],
      ["a global core.hooksPath", entry(GLOBAL, "core.hookspath", "/operator/hooks")],
      [
        "a global http.<url>.extraHeader",
        entry(GLOBAL, "http.https://gitlab.example.test/.extraheader", "X-Extra: 1"),
      ],
      ["a checkout url rewrite", entry(LOCAL, "url.https://example.test/.insteadof", "x")],
      ["an executable credential helper", entry(GLOBAL, "credential.helper", "!/tmp/steal")],
      [
        "an executable credential helper scoped to the project's host",
        entry(GLOBAL, "credential.https://gitlab.example.test.helper", "!/tmp/steal"),
      ],
    ])("refuses %s as refused-configuration", async (_label, config) => {
      await expect(verify(config)).rejects.toMatchObject({ code: "refused-configuration" });
    });

    it.each([
      ["a key with no value", `${LOCAL}\0core.foo\0`],
      ["a listing with an odd field", `${LOCAL}\0`],
    ])("reports %s as unsafe-configuration, not as a refused setting", async (_label, config) => {
      await expect(verify(config)).rejects.toMatchObject({ code: "unsafe-configuration" });
    });

    it("reads the listing under the declared bound, and no other command under that bound (#2363)", async () => {
      const commands = new FakeCommands();
      await new DeterministicLocalGitPublisher(commands, { HOME }).assertConfiguredIdentity(
        plan(),
        "/delivery",
      );
      const listing = commands.bounds.filter(
        (entry) => entry.call === "config --includes --show-origin --null --list",
      );
      expect(listing).toEqual([
        {
          call: "config --includes --show-origin --null --list",
          maxOutputBytes: limit(GIT_CONFIGURATION_LISTING_LIMIT).value,
        },
      ]);
      // The other commands keep the publisher's own output cap, which is not the listing's.
      const others = commands.bounds.filter((entry) => !entry.call.startsWith("config --includes"));
      expect(others.length).toBeGreaterThan(0);
      expect(new Set(others.map((entry) => entry.maxOutputBytes)).size).toBe(1);
      expect(others[0]!.maxOutputBytes).not.toBe(listing[0]!.maxOutputBytes);
    });

    it("takes the bound from the catalog, so a host override moves the bound (#2363)", async () => {
      vi.stubEnv("DOCSFAB_DELIVERY_GIT_CONFIGURATION_LISTING_MAX_BYTES", "4096");
      const commands = new FakeCommands();
      await new DeterministicLocalGitPublisher(commands, { HOME }).assertConfiguredIdentity(
        plan(),
        "/delivery",
      );
      expect(
        commands.bounds.find((entry) => entry.call.startsWith("config --includes"))?.maxOutputBytes,
      ).toBe(4096);
    });

    it.each([
      ["exits with a failure", 128, ""],
      [
        "is stopped at the output bound after a parseable prefix",
        1,
        `${LOCAL}\0user.name\nOperator\0`,
      ],
    ])(
      "reports a listing that %s as unsafe-configuration, not as a failed commit (#2363)",
      async (_label, exitCode, printed) => {
        const commands = new FakeCommands();
        commands.configExit = exitCode;
        commands.config = printed;
        await expect(
          new DeterministicLocalGitPublisher(commands, { HOME }).assertConfiguredIdentity(
            plan(),
            "/delivery",
          ),
        ).rejects.toMatchObject({ code: "unsafe-configuration" });
        // The same check runs before every Git observation, so each reports it the same way.
        await expect(
          new DeterministicLocalGitPublisher(commands, { HOME }).remoteBranchRevision(
            plan(),
            "/delivery",
          ),
        ).rejects.toMatchObject({ code: "unsafe-configuration" });
        // Positive control: the same listing, with the exit status of a listing that finished, passes.
        commands.configExit = 0;
        await expect(
          new DeterministicLocalGitPublisher(commands, { HOME }).assertConfiguredIdentity(
            plan(),
            "/delivery",
          ),
        ).resolves.toBeUndefined();
      },
    );

    it("reports a git version that fails, as an Apple Git does for a malformed global file, as unsafe-configuration (#2363)", async () => {
      const commands = new FakeCommands();
      commands.versionExit = 128;
      await expect(
        new DeterministicLocalGitPublisher(commands, { HOME }).assertConfiguredIdentity(
          plan(),
          "/delivery",
        ),
      ).rejects.toMatchObject({ code: "unsafe-configuration" });
      // Nothing else ran: the failing version is where the check stops.
      expect(commands.calls.map((call) => call.join(" "))).toEqual(["version"]);
      // Positive control: the same publisher with a working git version proceeds.
      commands.versionExit = 0;
      await expect(
        new DeterministicLocalGitPublisher(commands, { HOME }).assertConfiguredIdentity(
          plan(),
          "/delivery",
        ),
      ).resolves.toBeUndefined();
    });

    it("never reads a refused setting past the output bound as accepted (#2363)", async () => {
      // The runner stops a listing at the bound and hands back the prefix it read. The refused
      // setting sits beyond it, so only the exit status can tell that the listing is incomplete.
      const commands = new FakeCommands();
      commands.configExit = 1;
      commands.config = entry(GLOBAL, "user.name", "Operator");
      await expect(
        new DeterministicLocalGitPublisher(commands, { HOME }).assertConfiguredIdentity(
          plan(),
          "/delivery",
        ),
      ).rejects.toMatchObject({ code: "unsafe-configuration" });
    });

    describe("a HOME that is not the operator's own", () => {
      const sshCommand = (origin: string) =>
        entry(origin, "core.sshcommand", "ssh -i /operator/key");

      it.each([
        ["a relative HOME", { HOME: "~" }, "file:~/.gitconfig", undefined],
        [
          "a HOME inside the directory Git runs in",
          { HOME: "/delivery/home" },
          "file:/delivery/home/.gitconfig",
          undefined,
        ],
        [
          "a HOME inside the source checkout the publisher was given",
          { HOME: "/source/home" },
          "file:/source/home/.gitconfig",
          { repositoryRoots: ["/source"] },
        ],
      ] as const)(
        "refuses a global core.sshCommand under %s as refused-configuration (#2363)",
        async (_label, env, origin, options) => {
          const commands = new FakeCommands();
          commands.config = sshCommand(origin);
          await expect(
            new DeterministicLocalGitPublisher(commands, env, options).assertConfiguredIdentity(
              plan(),
              "/delivery",
            ),
          ).rejects.toMatchObject({ code: "refused-configuration" });
          // Positive control: the operator's own HOME is accepted.
          const own = new FakeCommands();
          own.config = sshCommand(`file:${HOME}/.gitconfig`);
          await expect(
            new DeterministicLocalGitPublisher(own, { HOME }, options).assertConfiguredIdentity(
              plan(),
              "/delivery",
            ),
          ).resolves.toBeUndefined();
          // Positive control: the source checkout counts only because the publisher was told
          // where it is; the directory Git runs in always counts.
          if (options) {
            await expect(
              new DeterministicLocalGitPublisher(commands, env).assertConfiguredIdentity(
                plan(),
                "/delivery",
              ),
            ).resolves.toBeUndefined();
          }
        },
      );

      it("sees through a link: a HOME that leads into the source checkout is inside the checkout (#2363)", async () => {
        const root = await mkdtemp(join(tmpdir(), "docsfab-git-publisher-links-"));
        try {
          const source = join(root, "source");
          const outside = join(root, "elsewhere");
          await mkdir(join(source, "home"), { recursive: true });
          await mkdir(outside);
          await symlink(join(source, "home"), join(root, "home-link"));
          await symlink(outside, join(root, "elsewhere-link"));
          const verifyHome = async (home: string) => {
            const commands = new FakeCommands();
            commands.config = sshCommand(`file:${home}/.gitconfig`);
            await new DeterministicLocalGitPublisher(
              commands,
              { HOME: home },
              { repositoryRoots: [source] },
            ).assertConfiguredIdentity(plan(), "/delivery");
          };
          await expect(verifyHome(join(root, "home-link"))).rejects.toMatchObject({
            code: "refused-configuration",
          });
          // Positive control: a link to a directory outside the checkout is the operator's own.
          await expect(verifyHome(join(root, "elsewhere-link"))).resolves.toBeUndefined();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });

      it("does not refuse an inert setting from the global files of a HOME that is not the operator's own", async () => {
        const commands = new FakeCommands();
        commands.config = entry("file:~/.gitconfig", "commit.gpgsign", "true");
        await expect(
          new DeterministicLocalGitPublisher(commands, { HOME: "~" }).assertConfiguredIdentity(
            plan(),
            "/delivery",
          ),
        ).resolves.toBeUndefined();
      });

      it("accepts the system files for core.sshCommand under any HOME", async () => {
        const commands = new FakeCommands();
        commands.config = sshCommand("file:/etc/gitconfig");
        await expect(
          new DeterministicLocalGitPublisher(commands, { HOME: "~" }).assertConfiguredIdentity(
            plan(),
            "/delivery",
          ),
        ).resolves.toBeUndefined();
      });
    });

    it("reports an old Git and a remote that no longer names the project as unsafe-configuration", async () => {
      const old = new FakeCommands();
      old.version = "git version 2.9.4\n";
      await expect(
        new DeterministicLocalGitPublisher(old, { HOME }).assertConfiguredIdentity(
          plan(),
          "/delivery",
        ),
      ).rejects.toMatchObject({ code: "unsafe-configuration" });
      const moved = new FakeCommands();
      moved.fetchUrl = "git@gitlab.example.test:group/other.git";
      await expect(
        new DeterministicLocalGitPublisher(moved, { HOME }).assertConfiguredIdentity(
          plan(),
          "/delivery",
        ),
      ).rejects.toMatchObject({ code: "unsafe-configuration" });
      // Positive control: the unchanged remote and a current Git pass.
      await expect(verify("")).resolves.toBeUndefined();
    });
  });

  it("creates an actual deterministic commit with the attested tree, base parent, and configured identity", async () => {
    const repository = await mkdtemp(join(tmpdir(), "docsfab-git-publisher-"));
    try {
      // Not initFixtureRepo: the publisher refuses a repository-local
      // commit.gpgsign as unsafe configuration. The padded identity is
      // deliberate; the publisher trims it.
      await git(repository, ["init", "--quiet"]);
      await git(repository, ["config", "user.name", "  Maintainer  "]);
      await git(repository, ["config", "user.email", " maintainer@example.test "]);
      await git(repository, ["remote", "add", "origin", "git@gitlab.example.test:group/docs.git"]);
      await writeFile(join(repository, "guide.md"), "before\n", "utf8");
      const baseRevision = await commitFixture(repository, "Base");
      await git(repository, ["branch", "docsfab-run/run-1", baseRevision]);
      await writeFile(join(repository, "guide.md"), "after\n", "utf8");
      await git(repository, ["add", "guide.md"]);
      const tree = await git(repository, ["write-tree"]);
      // Reproduce the freshly materialized worktree state: the authorized
      // index tree is exact, but its stat cache is intentionally unrefreshed.
      await git(repository, ["read-tree", tree]);
      await writeFile(join(repository, "guide.md"), "after\n", "utf8");
      await expect(
        git(repository, ["diff-files", "--quiet", "--"], { env: { GIT_OPTIONAL_LOCKS: "0" } }),
      ).rejects.toBeDefined();
      const selectedPlan = plan(baseRevision);
      const ready = {
        tree,
      } as DeliveryWorktreeReadyAttestation;
      const commitMessage = "Improve governed documentation\n\nDocsFab-Run: run-1\n";
      const gitCommands = new ExecFileGitPublisherCommandRunner();
      const commands: GitPublisherCommandRunner = {
        run: (command, args, cwd, options) =>
          gitCommands.run(command, args, cwd, {
            ...options,
            env: hermeticGitEnv(options.env),
          }),
      };
      const publisher = new DeterministicLocalGitPublisher(commands, process.env);
      let authorizationChecks = 0;

      const revision = await publisher.ensureCommit({
        plan: selectedPlan,
        ready,
        commitMessage,
        cwd: repository,
        assertAuthorized: () => {
          authorizationChecks += 1;
        },
      });
      expect(authorizationChecks).toBe(2);

      expect(await git(repository, ["rev-parse", `${revision}^{tree}`])).toBe(tree);
      expect(await git(repository, ["rev-parse", `${revision}^`])).toBe(baseRevision);
      expect(await git(repository, ["show", "-s", "--format=%an <%ae>|%cn <%ce>", revision])).toBe(
        "Maintainer <maintainer@example.test>|Maintainer <maintainer@example.test>",
      );
      expect(
        await publisher.ensureCommit({
          plan: selectedPlan,
          ready,
          commitMessage,
          cwd: repository,
        }),
      ).toBe(revision);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

function stripConfig(args: readonly string[]): readonly string[] {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args.slice(index);
}

function ok(stdout: string): GitPublisherCommandResult {
  return { exitCode: 0, stdout: Buffer.from(stdout) };
}

function failed(): GitPublisherCommandResult {
  return { exitCode: 1, stdout: Buffer.from("glpat-secret-must-be-discarded") };
}

function plan(baseRevision = BASE): LocalUserPublicationPlanV1 {
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
    baseRevision,
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
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate as never) };
}
