// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryRoots } from "./helpers/temp.js";

const injected = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));

vi.mock("../src/doctor-readiness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/doctor-readiness.js")>();
  return {
    ...actual,
    // Seams come from the fixture; everything the real command derives from
    // argv (the resolved repository and the live flag) wins over them.
    inspectDoctorReadiness: (options: Record<string, unknown> = {}) =>
      actual.inspectDoctorReadiness({ ...injected.options, ...options }),
  };
});

import { handleDoctorCommand } from "../src/cli/commands/doctor.js";
import { parseDoctorArguments } from "../src/cli/profile-arguments.js";
import { parseDocsFabInitArguments } from "../src/init/plan.js";
import { revisionPolicyForDraftMr } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import {
  formatDoctorReadiness,
  inspectDoctorReadiness,
  type DoctorReadinessCommandRunner,
  type DoctorReadinessResult,
} from "../src/doctor-readiness.js";
import { resolveDocsFabPrivateRoots } from "../src/init.js";
import { parseJsonEvidence } from "../src/json-evidence.js";
import { remediationText } from "../src/operator/remediation.js";
import type { ReadOnlyCommandRunner } from "../src/delivery/preflight.js";
import { DraftMrSeamCommands, type DraftMrSeamFixture } from "./gitlab-target-observation-fake.js";
import { validModelConfig } from "./helpers.js";

/**
 * Divergent identities: the checkout branch, the target branch, and the two
 * commit identities are all distinct, so a swapped structured field cannot pass.
 */
const HEAD_BRANCH = "example-user/task-xyz";
const TARGET_BRANCH = "main";
const HEAD_REVISION = "a1".repeat(20);
const TARGET_REVISION = "c7".repeat(20);
const HOST = "gitlab.example.test";
const PROJECT_ID = 4711;
/** Every subcommand doctor is allowed to issue; all are read-only. */
const READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "git --version",
  "git rev-parse",
  "git config",
  "git symbolic-ref",
  "git cat-file",
  "git ls-tree",
  "git status",
  "git remote",
  "git merge-base",
  "glab --version",
  "glab version",
  "glab auth",
  "glab api",
  "glab config",
]);

const roots = temporaryRoots();

afterEach(async () => {
  injected.options = {};
  process.exitCode = undefined;
});

describe("doctor draft-mr publication readiness", () => {
  it("separates a ready publication observation from a blocked aggregate draft use", async () => {
    const fixture = await draftMrFixture({ targetContainsHead: true, targetObjectLocal: true });
    const base = doctorRunner(fixture.seam);
    const result = await inspectDoctorReadiness({
      ...fixture.doctorOptions,
      use: "draft-mr",
      commands: {
        run(command, args, cwd) {
          if (
            command === "git" &&
            args.join(" ") === "status --porcelain=v1 --untracked-files=all"
          ) {
            return Promise.resolve({ exitCode: 0, stdout: " M README.md\n" });
          }
          return base.run(command, args, cwd);
        },
        probeCredential: base.probeCredential.bind(base),
      },
    });
    expect(result.draftMrReadiness.state).toBe("ready");
    expect(result.status).toBe("blocked");
    expect(result.useReadiness?.["draft-mr"].blockers).toContain("repository-source-dirty");
    const human = formatDoctorReadiness(result);
    expect(human).toContain("Draft-MR publication observation: ready.");
    expect(human).toContain("draft-mr readiness: blocked; blockers: repository-source-dirty");
  });

  it("reports ready under the frozen target-branch-head policy for a behind feature branch", async () => {
    const { result, commands } = await runDoctor({
      targetContainsHead: true,
      targetObjectLocal: true,
    });

    expect(result.checkoutBranch).toBe(HEAD_BRANCH);
    expect(result.checkoutRevision).toBe(HEAD_REVISION);
    expect(result.gitlabTargetBranch).toBe(TARGET_BRANCH);
    expect(result.gitlabTargetRevision).toBe(TARGET_REVISION);
    expect(
      new Set([
        result.checkoutBranch,
        result.checkoutRevision,
        result.gitlabTargetBranch,
        result.gitlabTargetRevision,
      ]).size,
    ).toBe(4);
    expect(result.draftMrReadiness).toMatchObject({
      state: "ready",
      revisionPolicy: "target-branch-head",
      runBaseAction: "fetch-target-object",
      checkoutRelation: "behind-target",
      featureBranch: true,
      checkoutHeadRunBase: "stale-revision",
      blockers: [],
    });
    expect(result.autoModesReady).toContain("draft-mr");

    // Acceptance: the behind-GitLab, non-target-branch condition is detected and
    // the human render carries the remediation for the explicit-revision route.
    const output = formatDoctorReadiness(result);
    expect(output).toContain(`Checkout: ${HEAD_BRANCH} @ ${HEAD_REVISION}`);
    expect(output).toContain(
      `GitLab target: ${TARGET_BRANCH} @ ${TARGET_REVISION} (ahead of checkout)`,
    );
    expect(output).toContain(`--revision ${TARGET_BRANCH} after git fetch`);
    expect(output).toContain("--revision HEAD would still be refused as stale-revision");

    // Doctor stays read-only; the reported `fetch-target-object` run base is
    // never executed.
    expect(commands.calls.length).toBeGreaterThan(10);
    expect(
      commands.calls
        .map((call) => call.split(" ").slice(0, 2).join(" "))
        .filter((subcommand) => !READ_ONLY_SUBCOMMANDS.has(subcommand)),
    ).toEqual([]);
  });

  it("contacts GitLab for nothing at all unless the operator asks for live checks", async () => {
    const fixture = await draftMrFixture({ targetContainsHead: true, targetObjectLocal: true });
    let publicationInvocations = 0;
    const refuseEveryCall: ReadOnlyCommandRunner = {
      run(command, args) {
        publicationInvocations += 1;
        throw new Error(
          `offline doctor issued a publication-path command: ${command} ${args.join(" ")}`,
        );
      },
    };
    const doctorSeam = doctorRunner(fixture.seam);
    const doctorCalls: string[] = [];

    const result = await inspectDoctorReadiness({
      ...fixture.doctorOptions,
      live: false,
      publicationCommands: refuseEveryCall,
      commands: {
        run(command, args, cwd) {
          doctorCalls.push(`${command} ${args.join(" ")}`);
          return doctorSeam.run(command, args, cwd);
        },
        probeCredential: doctorSeam.probeCredential.bind(doctorSeam),
      },
    });

    // The seam throws on any call, so a single invocation would surface here.
    expect(publicationInvocations).toBe(0);
    // Nor through doctor's own runner.
    expect(doctorCalls.filter((call) => call.startsWith("glab api"))).toEqual([]);
    expect(doctorCalls.filter((call) => call.startsWith("git merge-base"))).toEqual([]);
    expect(doctorCalls).not.toContain(`glab auth status --hostname ${HOST}`);

    // The structured fields are present and say why they are empty.
    expect(result.draftMrReadiness.state).toBe("not-observed");
    expect(result.draftMrReadiness.blockers).toEqual([]);
    expect(result.draftMrReadiness.reason).toContain("--live");
    expect(result.gitlabTargetBranch).toBeNull();
    expect(result.gitlabTargetRevision).toBeNull();
    expect(result.remediationArgv).toBeNull();
    expect(result.checkoutBranch).toBe(HEAD_BRANCH);
    expect(result.checkoutRevision).toBe(HEAD_REVISION);

    expect(result.status).toBe("ready");
    expect(result.autoModesReady).toEqual(["dry-run", "patch-only"]);
    expect(formatDoctorReadiness(result)).toContain("GitLab target: not observed");
  });

  it("makes no GitLab call under --live while offline readiness is blocked locally", async () => {
    // A purely local blocker; the other live probes already refuse to run here.
    const fixture = await draftMrFixture({ targetContainsHead: true, targetObjectLocal: true });
    let publicationInvocations = 0;
    const refuseEveryCall: ReadOnlyCommandRunner = {
      run(command, args) {
        publicationInvocations += 1;
        throw new Error(`observed GitLab while blocked: ${command} ${args.join(" ")}`);
      },
    };
    const doctorSeam = doctorRunner(fixture.seam);
    const doctorCalls: string[] = [];

    const result = await inspectDoctorReadiness({
      ...fixture.doctorOptions,
      live: true,
      publicationCommands: refuseEveryCall,
      commands: {
        run(command, args, cwd) {
          doctorCalls.push(`${command} ${args.join(" ")}`);
          return doctorSeam.run(command, args, cwd);
        },
        probeCredential: doctorSeam.probeCredential.bind(doctorSeam),
      },
      // The one blocker, and it is local.
      loadConfiguration: () => {
        throw { issues: [{ field: "MODEL_API_KEY" }] };
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.diagnostics.map((d) => d.code)).toContain("provider-credentials-missing");
    expect(publicationInvocations).toBe(0);
    expect(doctorCalls.filter((c) => c.startsWith("glab api"))).toEqual([]);

    expect(result.liveConnectivity.gitlab).toBe("not-attempted");
    expect(result.gitlabTargetBranch).toBeNull();
    expect(result.gitlabTargetRevision).toBeNull();
    expect(result.draftMrReadiness.state).toBe("not-observed");
    expect(result.draftMrReadiness.reason).toContain("offline readiness is blocked");
  });

  it("evaluates the run-base policy the draft-mr default actually selects", async () => {
    const { result } = await runDoctor({ targetContainsHead: true, targetObjectLocal: true });
    // Pins the named default against the shipped selector, so the two cannot drift.
    expect(result.draftMrReadiness.revisionPolicy).toBe(revisionPolicyForDraftMr("HEAD", false));
  });

  it("reports an already-local run base when the checkout is at GitLab's target head", async () => {
    const { result } = await runDoctor({
      headRevision: TARGET_REVISION,
      targetContainsHead: true,
      targetObjectLocal: true,
    });

    expect(result.draftMrReadiness).toMatchObject({
      state: "ready",
      runBaseAction: "already-local",
      checkoutRelation: "at-target",
      featureBranch: true,
      checkoutHeadRunBase: "usable",
    });
    expect(result.remediationArgv).toBeNull();
    expect(result.autoModesReady).toContain("draft-mr");
    expect(formatDoctorReadiness(result)).not.toContain("would still be refused");
  });

  it("refuses draft-mr for an operator below the push access level publication needs", async () => {
    // Reporter: the publication preflight refuses anything under Developer, so
    // ready here would defer the refusal to after a full write.
    const { result, fixture } = await runDoctor({
      accessLevel: 20,
      targetContainsHead: true,
      targetObjectLocal: true,
    });

    // The target was observed; this is not an observation failure.
    expect(result.gitlabTargetBranch).toBe(TARGET_BRANCH);
    expect(result.gitlabTargetRevision).toBe(TARGET_REVISION);
    expect(result.draftMrReadiness.state).toBe("blocked");
    expect(result.draftMrReadiness.blockers).toEqual(["insufficient-push-access"]);
    expect(result.draftMrReadiness.reason).toMatch(/Developer/u);
    expect(result.autoModesReady).not.toContain("draft-mr");
    expect(result.autoModesReady).toContain("patch-only");
    // The project endpoint, not `members/all`: a non-member at access level 0
    // is also blocked here, and `members/all` would itself be refused for them.
    expect(result.remediationArgv).toEqual([
      "glab",
      "api",
      "--hostname",
      HOST,
      `projects/${PROJECT_ID}`,
    ]);
    void fixture;
  });

  it("grants draft-mr at exactly the push access level publication requires", async () => {
    // Boundary: 30 is Developer, the lowest level the publication path accepts.
    const { result } = await runDoctor({
      accessLevel: 30,
      targetContainsHead: true,
      targetObjectLocal: true,
    });
    expect(result.draftMrReadiness.state).toBe("ready");
    expect(result.draftMrReadiness.blockers).toEqual([]);
    expect(result.autoModesReady).toContain("draft-mr");
  });

  it("blocks draft-mr with git-configuration-refused when the Git configuration holds a refused setting (#2363)", async () => {
    // The observation doctor shares with the run's pre-model check reads the Git configuration
    // the publisher will read, so doctor names the stop before a run starts.
    const { result } = await runDoctor({
      effectiveConfig: "file:.git/config\0core.sshcommand\nssh -i /tmp/key\0",
    });

    expect(result.draftMrReadiness.state).toBe("blocked");
    expect(result.draftMrReadiness.blockers).toEqual(["git-configuration-refused"]);
    expect(result.draftMrReadiness.reason).toBe(remediationText("remove-refused-git-setting"));
    expect(result.gitlabTargetBranch).toBeNull();
    expect(result.autoModesReady).not.toContain("draft-mr");
    expect(result.remediationArgv?.[0]).toBe("docsfab");

    // Positive control: accepted settings leave the same checkout ready.
    const accepted = await runDoctor({
      targetContainsHead: true,
      targetObjectLocal: true,
      effectiveConfig:
        "file:.git/config\0commit.gpgsign\nfalse\0file:/etc/gitconfig\0core.sshcommand\nssh\0",
    });
    expect(accepted.result.draftMrReadiness.state).toBe("ready");
    expect(accepted.result.draftMrReadiness.blockers).toEqual([]);
  });

  it("explains the GitLab authentication blocker instead of granting draft-mr", async () => {
    const { result } = await runDoctor({ auth: "unauthenticated" });

    expect(result.draftMrReadiness.state).toBe("blocked");
    expect(result.draftMrReadiness.blockers).toEqual(["gitlab-unauthenticated"]);
    expect(result.draftMrReadiness.reason).not.toBe("");
    expect(result.gitlabTargetBranch).toBeNull();
    expect(result.gitlabTargetRevision).toBeNull();
    expect(result.autoModesReady).not.toContain("draft-mr");

    expect(result.remediationArgv).toEqual(["glab", "auth", "login", "--hostname", HOST]);
    expect(remediationText("glab-auth-login")).toContain(
      result.remediationArgv!.slice(0, 4).join(" "),
    );
  });

  it("degrades to a structured blocker with no GitLab target when the remote is missing", async () => {
    const { result, fixture } = await runDoctor({ remote: "missing" });

    expect(result.draftMrReadiness.state).toBe("blocked");
    expect(result.draftMrReadiness.blockers).toEqual(["gitlab-project-mismatch"]);
    expect(result.draftMrReadiness.checkoutRelation).toBe("unknown");
    expect(result.draftMrReadiness.revisionPolicy).toBeNull();
    expect(result.draftMrReadiness.reason).not.toBe("");
    expect(result.gitlabTargetBranch).toBeNull();
    expect(result.gitlabTargetRevision).toBeNull();
    expect(result.autoModesReady).not.toContain("draft-mr");

    const argv = result.remediationArgv!;
    expect(argv).toEqual(["docsfab", "init", "--repo", fixture.repositoryPath]);
    expect(parseDocsFabInitArguments(argv.slice(2), "/").repositoryPath).toBe(
      fixture.repositoryPath,
    );
  });

  it.each([
    ["HTTPS", `https://${HOST}/group/project.git`, HOST],
    ["scp", `git@${HOST}:group/project.git`, HOST],
    ["SSH", `ssh://git@${HOST}/group/project.git`, HOST],
    ["SSH with a port", `ssh://git@${HOST}:12051/group/project.git`, HOST],
    [
      "enterprise SSH subgroup",
      "ssh://git@gitlab.enterprise.example.test:12051/group/subgroup/project.git",
      "gitlab.enterprise.example.test",
    ],
  ])(
    "accepts a canonical %s GitLab remote in readiness and the doctor CLI",
    async (_label, remote, expectedHost) => {
      const fixture = await draftMrFixture();
      const commands = doctorRunnerWithRemote(fixture.seam, `${remote}\n`);
      const result = await inspectDoctorReadiness({
        ...fixture.doctorOptions,
        live: false,
        commands,
      });
      expect(result.useReadiness?.["draft-mr"].diagnostics).not.toContainEqual(
        expect.objectContaining({ code: "gitlab-project-mismatch" }),
      );
      const cli = await captureDoctorJson(fixture, ["--use", "draft-mr", "--json"], {
        live: false,
        commands,
      });
      expect(cli.payload.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: "gitlab-project-mismatch" }),
      );
      expect(fixture.seam.calls).toContain(`glab config get token --host ${expectedHost}`);
      const human = await captureDoctorHuman(fixture, ["--use", "draft-mr"], {
        live: false,
        commands,
      });
      expect(human).not.toContain("Code: gitlab-project-mismatch");
    },
  );

  it.each([
    ["HTTPS username", `https://operator@${HOST}/group/project.git`],
    ["HTTPS password", `https://operator:secret@${HOST}/group/project.git`],
    ["SSH wrong user", `ssh://operator@${HOST}/group/project.git`],
    ["HTTPS query", `https://${HOST}/group/project.git?x=1`],
    ["SSH hash", `ssh://git@${HOST}/group/project.git#fragment`],
    ["zero SSH port", `ssh://git@${HOST}:0/group/project.git`],
    ["oversized SSH port", `ssh://git@${HOST}:65536/group/project.git`],
    ["bad project path", `ssh://git@${HOST}/project.git`],
    ["non-GitLab host", "git@github.com:group/project.git"],
    ["unsupported scheme", `http://${HOST}/group/project.git`],
    ["scp without git user", `${HOST}:group/project.git`],
    ["explicit HTTPS port", `https://${HOST}:8443/group/project.git`],
    ["ambiguous URLs", `https://${HOST}/group/project.git\nssh://git@${HOST}/group/project.git`],
  ])(
    "refuses %s with the named GitLab mismatch in JSON and human doctor",
    async (_label, remote) => {
      const fixture = await draftMrFixture();
      const commands = doctorRunnerWithRemote(fixture.seam, `${remote}\n`);
      const result = await inspectDoctorReadiness({
        ...fixture.doctorOptions,
        live: false,
        commands,
      });
      expect(result.useReadiness?.["draft-mr"].diagnostics).toContainEqual(
        expect.objectContaining({ code: "gitlab-project-mismatch" }),
      );
      const cli = await captureDoctorJson(fixture, ["--use", "draft-mr", "--json"], {
        live: false,
        commands,
      });
      expect(cli.payload.diagnostics).toContainEqual(
        expect.objectContaining({ code: "gitlab-project-mismatch" }),
      );
      const human = await captureDoctorHuman(fixture, ["--use", "draft-mr"], {
        live: false,
        commands,
      });
      expect(human).toContain("Code: gitlab-project-mismatch");
      expect(fixture.seam.calls.some((call) => call.startsWith("glab config get token"))).toBe(
        false,
      );
    },
  );

  it("propagates an unexpected remote-parser fault through the shipped readiness call", async () => {
    const fixture = await draftMrFixture();
    const commands = doctorRunnerWithRemote(fixture.seam, {
      split: () => [17],
    } as unknown as string);
    await expect(
      inspectDoctorReadiness({ ...fixture.doctorOptions, live: false, commands }),
    ).rejects.toThrow(TypeError);
  });

  it("degrades to a structured unknown with a reason when the GitLab API is unreachable", async () => {
    const { result, fixture } = await runDoctor({ api: "unreachable" });

    expect(result.draftMrReadiness.state).toBe("unknown");
    expect(result.draftMrReadiness.blockers).toEqual(["gitlab-unreachable"]);
    expect(result.draftMrReadiness.reason).toContain("unreachable");
    expect(result.liveConnectivity.gitlab).toBe("failed");
    expect(result.useReadiness?.["draft-mr"].status).toBe("blocked");
    expect(result.useReadiness?.["draft-mr"].diagnostics).toContainEqual(
      expect.objectContaining({
        code: "gitlab-live-unavailable",
        nextCommand: expect.stringContaining("GitLab API"),
      }),
    );
    expect(
      result.useReadiness?.["draft-mr"].diagnostics.find(
        (item) => item.code === "gitlab-live-unavailable",
      )?.nextCommand,
    ).not.toContain("auth login");
    expect(result.gitlabTargetRevision).toBeNull();
    expect(result.autoModesReady).not.toContain("draft-mr");

    const argv = result.remediationArgv!;
    expect(argv).toEqual(["docsfab", "doctor", "--repo", fixture.repositoryPath, "--live"]);
    const parsed = parseDoctorArguments(argv.slice(2));
    expect(parsed.repositoryPath).toBe(fixture.repositoryPath);
    expect(parsed.live).toBe(true);
  });

  it("emits all six structured fields through docsfab doctor --json", async () => {
    const fixture = await draftMrFixture({
      targetContainsHead: true,
      targetObjectLocal: true,
    });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (value: string) => {
      logs.push(value);
    };
    try {
      // Without `--live` the record still carries every field and says why the
      // live ones are empty, rather than emitting bare nulls.
      injected.options = { ...fixture.doctorOptions, live: false };
      await handleDoctorCommand(["--repo", fixture.repositoryPath, "--json"]);
    } finally {
      console.log = originalLog;
    }

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0]!) as DoctorReadinessResult;
    for (const field of [
      "checkoutBranch",
      "checkoutRevision",
      "gitlabTargetBranch",
      "gitlabTargetRevision",
      "draftMrReadiness",
      "remediationArgv",
    ] as const) {
      expect(payload).toHaveProperty(field);
    }
    expect(payload.checkoutBranch).toBe(HEAD_BRANCH);
    expect(payload.checkoutRevision).toBe(HEAD_REVISION);
    expect(payload.gitlabTargetBranch).toBeNull();
    expect(payload.gitlabTargetRevision).toBeNull();
    expect(payload.draftMrReadiness.state).toBe("not-observed");
    expect(payload.draftMrReadiness.reason).toContain("--live");
    expect(payload.remediationArgv).toBeNull();
  });

  it("accepts docsfab doctor --live --json and observes the target in the canonical envelope", async () => {
    const fixture = await draftMrFixture({ targetContainsHead: true, targetObjectLocal: true });
    // The seam is handed `live: false`, so only the parsed `--live` flag can turn
    // the observation on.
    const live = await captureDoctorJson(fixture, ["--live", "--json"], { live: false });
    const offline = await captureDoctorJson(fixture, ["--json"], { live: false });

    // Canonical form is required, so any ad-hoc rendering fails here.
    expect(() => parseJsonEvidence(live.raw, { requireCanonical: true })).not.toThrow();
    expect(live.payload.schemaVersion).toBe(1);
    expect(live.payload.kind).toBe("docsfab-doctor-readiness");
    // Same envelope as the offline record, key for key.
    expect(Object.keys(live.payload).sort()).toEqual(Object.keys(offline.payload).sort());
    expect(Object.keys(live.payload.draftMrReadiness).sort()).toEqual(
      Object.keys(offline.payload.draftMrReadiness).sort(),
    );

    expect(live.payload.checkoutBranch).toBe(HEAD_BRANCH);
    expect(live.payload.checkoutRevision).toBe(HEAD_REVISION);
    expect(live.payload.gitlabTargetBranch).toBe(TARGET_BRANCH);
    expect(live.payload.gitlabTargetRevision).toBe(TARGET_REVISION);
    expect(
      new Set([
        live.payload.checkoutBranch,
        live.payload.checkoutRevision,
        live.payload.gitlabTargetBranch,
        live.payload.gitlabTargetRevision,
      ]).size,
    ).toBe(4);
    expect(live.payload.draftMrReadiness).toMatchObject({
      state: "ready",
      revisionPolicy: "target-branch-head",
      checkoutRelation: "behind-target",
      blockers: [],
    });
    expect(live.payload.remediationArgv).toBeNull();
    expect(live.payload.liveConnectivity.requested).toBe(true);
    expect(live.payload.autoModesReady).toContain("draft-mr");
    expect(process.exitCode).toBeUndefined();

    expect(offline.payload.gitlabTargetBranch).toBeNull();
    expect(offline.payload.gitlabTargetRevision).toBeNull();
    expect(offline.payload.draftMrReadiness.state).toBe("not-observed");
  });

  it("carries the remediation argv in --live --json when the observed target refuses publication", async () => {
    // Reporter: the target is observed, so remediation is a real argv, not null.
    const fixture = await draftMrFixture({
      accessLevel: 20,
      targetContainsHead: true,
      targetObjectLocal: true,
    });
    const live = await captureDoctorJson(fixture, ["--live", "--json"], { live: false });

    expect(() => parseJsonEvidence(live.raw, { requireCanonical: true })).not.toThrow();
    expect(live.payload.gitlabTargetBranch).toBe(TARGET_BRANCH);
    expect(live.payload.gitlabTargetRevision).toBe(TARGET_REVISION);
    expect(live.payload.draftMrReadiness.state).toBe("blocked");
    expect(live.payload.draftMrReadiness.blockers).toEqual(["insufficient-push-access"]);
    expect(live.payload.remediationArgv).toEqual([
      "glab",
      "api",
      "--hostname",
      HOST,
      `projects/${PROJECT_ID}`,
    ]);
    expect(live.payload.autoModesReady).not.toContain("draft-mr");
  });

  it("keeps --live --json structurally not-observed while offline readiness is blocked", async () => {
    const fixture = await draftMrFixture({ targetContainsHead: true, targetObjectLocal: true });
    const blockedLive = await captureDoctorJson(fixture, ["--live", "--json"], {
      live: false,
      // One purely local blocker; nothing about it needs the network.
      loadConfiguration: () => {
        throw { issues: [{ field: "MODEL_API_KEY" }] };
      },
    });
    const offline = await captureDoctorJson(fixture, ["--json"], { live: false });

    expect(() => parseJsonEvidence(blockedLive.raw, { requireCanonical: true })).not.toThrow();
    expect(blockedLive.payload.kind).toBe("docsfab-doctor-readiness");
    expect(Object.keys(blockedLive.payload).sort()).toEqual(Object.keys(offline.payload).sort());
    expect(blockedLive.payload.status).toBe("blocked");
    expect(blockedLive.payload.liveConnectivity.gitlab).toBe("not-attempted");
    expect(blockedLive.payload.gitlabTargetBranch).toBeNull();
    expect(blockedLive.payload.gitlabTargetRevision).toBeNull();
    expect(blockedLive.payload.draftMrReadiness.state).toBe("not-observed");
    expect(blockedLive.payload.draftMrReadiness.reason).toContain("offline readiness is blocked");
    expect(blockedLive.payload.remediationArgv).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it.each(["local-review", "local-patch"] as const)(
    "exits blocked for selected %s when committed project authority is invalid",
    async (use) => {
      const fixture = await draftMrFixture();
      await writeFile(resolve(fixture.repositoryPath, ".docsfab.json"), '{"schemaVersion":2}\n');
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Doctor Test",
            "-c",
            "user.email=doctor@example.test",
            ...args,
          ],
          { cwd: fixture.repositoryPath, stdio: "pipe" },
        );
      git("init", "-q", "-b", "main");
      git("add", "--", ".docsfab.json");
      git("commit", "-qm", "fixture");

      const selected = await captureDoctorJson(fixture, ["--use", use, "--json"], { live: false });
      expect(selected.payload.selectedUse).toBe(use);
      expect(selected.payload.status).toBe("blocked");
      expect(selected.payload.diagnostics).toContainEqual(
        expect.objectContaining({ code: "project-config-invalid" }),
      );
      expect(process.exitCode).toBe(1);
    },
  );
});

/** Capture the real human CLI rendering from the same injected command seam. */
async function captureDoctorHuman(
  fixture: Awaited<ReturnType<typeof draftMrFixture>>,
  argv: readonly string[],
  seamOverrides: Record<string, unknown> = {},
): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value: string) => {
    logs.push(value);
  };
  try {
    injected.options = { ...fixture.doctorOptions, ...seamOverrides };
    await handleDoctorCommand(["--repo", fixture.repositoryPath, ...argv]);
  } finally {
    console.log = originalLog;
  }
  expect(logs).toHaveLength(1);
  return logs[0]!;
}

/** Runs the real command and returns both the raw line and the parsed record. */
async function captureDoctorJson(
  fixture: Awaited<ReturnType<typeof draftMrFixture>>,
  argv: readonly string[],
  seamOverrides: Record<string, unknown> = {},
): Promise<{ raw: string; payload: DoctorReadinessResult }> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value: string) => {
    logs.push(value);
  };
  try {
    injected.options = { ...fixture.doctorOptions, ...seamOverrides };
    await handleDoctorCommand(["--repo", fixture.repositoryPath, ...argv]);
  } finally {
    console.log = originalLog;
  }
  expect(logs).toHaveLength(1);
  return { raw: logs[0]!, payload: JSON.parse(logs[0]!) as DoctorReadinessResult };
}

async function runDoctor(overrides: Partial<DraftMrSeamFixture> = {}): Promise<{
  result: DoctorReadinessResult;
  commands: DraftMrSeamCommands;
  fixture: Awaited<ReturnType<typeof draftMrFixture>>;
}> {
  const fixture = await draftMrFixture(overrides);
  const result = await inspectDoctorReadiness(fixture.doctorOptions);
  return { result, commands: fixture.seam, fixture };
}

async function draftMrFixture(overrides: Partial<DraftMrSeamFixture> = {}): Promise<{
  repositoryPath: string;
  seam: DraftMrSeamCommands;
  doctorOptions: Parameters<typeof inspectDoctorReadiness>[0];
}> {
  const root = await roots.create("docsfab-draft-mr-readiness-", { realpath: true });
  const repositoryPath = await realpath(
    await mkdir(resolve(root, "repository")).then(() => resolve(root, "repository")),
  );
  const home = resolve(root, "home");
  const state = resolve(root, "state");
  await Promise.all([mkdir(home), mkdir(state)]);
  await writeFile(
    resolve(repositoryPath, ".docsfab.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: TARGET_BRANCH },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
    })}\n`,
    { mode: 0o600 },
  );
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Doctor Test",
        "-c",
        "user.email=doctor@example.test",
        ...args,
      ],
      { cwd: repositoryPath, stdio: "pipe" },
    );
  git("init", "-q", "-b", "main");
  git("add", "--", ".docsfab.json");
  git("commit", "-qm", "fixture");
  const environment = { XDG_STATE_HOME: state };
  const privateRoots = resolveDocsFabPrivateRoots(repositoryPath, environment, home);
  await Promise.all(
    Object.values(privateRoots).map(async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );

  const seam = new DraftMrSeamCommands({
    repositoryPath,
    host: HOST,
    projectPath: "group/project",
    projectId: PROJECT_ID,
    headBranch: HEAD_BRANCH,
    headRevision: HEAD_REVISION,
    targetBranch: TARGET_BRANCH,
    targetRevision: TARGET_REVISION,
    ...overrides,
  });
  const config: DocsFabConfig = {
    projectRoot: repositoryPath,
    skillCrateDirectory: resolve(process.cwd(), "skill-crate"),
    qualityDirectory: resolve(process.cwd(), "quality"),
    qualityPackDirectory: resolve(process.cwd(), "quality-pack"),
    stateDirectory: privateRoots.runs,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      retryableCategories: ["timeout"],
    },
    model: validModelConfig,
  };
  const doctorOptions = {
    cwd: repositoryPath,
    environment,
    homeDirectory: home,
    // Observing the GitLab target is a live call; scenarios opt in as an operator does.
    live: true,
    commands: doctorRunner(seam),
    publicationCommands: seam,
    loadConfiguration: () => config,
    validateConfiguration: async () => undefined,
    checkProviderConnectivity: async () => undefined,
  };
  injected.options = doctorOptions as unknown as Record<string, unknown>;
  return { repositoryPath, seam, doctorOptions };
}

/** Override the actual git remote output while retaining the other command responses. */
function doctorRunnerWithRemote(
  seam: DraftMrSeamCommands,
  stdout: string,
): DoctorReadinessCommandRunner {
  const base = doctorRunner(seam);
  return {
    async run(command, args, cwd) {
      if (command === "git" && args.join(" ") === "remote get-url --all origin") {
        seam.calls.push(`git ${args.join(" ")}`);
        return { exitCode: 0, stdout };
      }
      return base.run(command, args, cwd);
    },
    async probeCredential(command, args, cwd) {
      seam.calls.push(`${command} ${args.join(" ")}`);
      return base.probeCredential(command, args, cwd);
    },
  };
}

/** Doctor's own runner shares the one seam; only `npm` is out of its scope. */
function doctorRunner(seam: DraftMrSeamCommands): DoctorReadinessCommandRunner {
  return {
    async run(command, args, cwd) {
      if (command === "npm") return { exitCode: 1, stdout: "" };
      return seam.run(command, args, cwd);
    },
    async probeCredential() {
      return "present";
    },
  };
}

/**
 * The retired `--live` / `--json` refusal appeared in several wordings across
 * documentation trees, so this scan reads every shipped page rather than
 * grepping one message.
 */
const DOCUMENTATION_ROOT = resolve(import.meta.dirname, "../../..");
const REFUSAL_VOCABULARY =
  /\b(?:cannot|can not|is rejected|rejects|rejected|refuse[sd]?|not supported|unsupported|must not|may not|is an error|are errors|no schema-v1 envelope)\b/iu;

/** True when one sentence claims the doctor `--live` / `--json` pairing is refused. */
function claimsTheRetiredRefusal(sentence: string): boolean {
  return (
    sentence.includes("--live") && sentence.includes("--json") && REFUSAL_VOCABULARY.test(sentence)
  );
}

function documentationRoots(): string[] {
  const roots = [resolve(DOCUMENTATION_ROOT, "docs")];
  const packages = resolve(DOCUMENTATION_ROOT, "packages");
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(packages, entry.name, "docs");
    try {
      if (statSync(candidate).isDirectory()) roots.push(candidate);
    } catch {
      // A package without its own documentation tree.
    }
  }
  return roots;
}

function documentationPages(): string[] {
  const pages: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.mdx?$/u.test(entry.name)) pages.push(path);
    }
  };
  for (const root of documentationRoots()) walk(root);
  return pages;
}

describe("doctor live-json documentation parity", () => {
  it("detects every retired wording and passes every replacement wording", () => {
    // Retired sentences, verbatim.
    for (const retired of [
      "`--live` cannot be combined with `--json`.",
      "doctor --live cannot use --json because live evidence has no schema-v1 envelope.",
      "`docsfab doctor --live` cannot combine with `--json`.",
      "`doctor --live --catalog --json` is rejected because the live result does not yet have a versioned JSON evidence envelope.",
    ]) {
      expect(claimsTheRetiredRefusal(retired)).toBe(true);
    }
    // Current wordings, and an unrelated refusal naming only one of the two flags.
    for (const current of [
      "`--live` combines with `--json`: the live record is the same canonical schema-v1 envelope as the offline one.",
      "`docsfab doctor --repo <path> --live --json` | Emits the same canonical record with the observed GitLab target facts.",
      "`doctor --live --catalog --json` is accepted, and the live result carries a versioned JSON evidence envelope exactly as the offline mode does.",
      "`docsfab run --json --verbose` are errors.",
    ]) {
      expect(claimsTheRetiredRefusal(current)).toBe(false);
    }
  });

  it("finds no shipped page claiming doctor --live and --json cannot combine", () => {
    const pages = documentationPages();
    // Guards against a scan that silently walked nothing.
    expect(documentationRoots().length).toBeGreaterThanOrEqual(2);
    expect(pages.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const page of pages) {
      // Prose wraps across lines in this repository, so sentences are rebuilt
      // from whitespace-normalized text rather than read line by line.
      const text = readFileSync(page, "utf8").replace(/\s+/gu, " ");
      for (const sentence of text.split(/(?<=\.)\s/u)) {
        if (claimsTheRetiredRefusal(sentence)) {
          offenders.push(`${page.slice(DOCUMENTATION_ROOT.length + 1)} :: ${sentence.trim()}`);
        }
      }
      // Either half of the retired parser message, wherever it appears.
      expect(text).not.toMatch(/cannot use --json/iu);
      expect(text).not.toMatch(/no schema-v1 envelope/iu);
    }
    expect(offenders).toEqual([]);
  });
});
