// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listWorkflows } from "../src/workflow-registry/catalog.js";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_WITHHELD_LINE,
  assertCollectableAcceptanceEvidence,
  bindAcceptanceJudgeEvidence,
  canonicalizeAcceptanceOutputRoot,
  canonicalizeCollectableEvidenceDestination,
  createAcceptancePlan,
  executeAcceptancePlan,
  offlineAcceptanceEnvironment,
  sanitizeAcceptancePhaseOutput,
  summarizeAcceptanceRunRecord,
  summarizeNetworkedPhaseFailure,
  type AcceptanceCommand,
  type AcceptancePhase,
  validateAcceptanceGates,
} from "../src/acceptance.js";
import {
  ACCEPTANCE_CHECK_LIMITATIONS,
  ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE,
  type HostRootOwnership,
} from "../src/acceptance-check-limitations.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";
import { buildRunResultV1, serializeRunResultV1 } from "../src/operator/run-result.js";
import type { RunRecord } from "../src/records/contracts.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";

function plan(
  live = false,
  judge = false,
  commandPrefix: string[] = [],
  hostRootOwner?: HostRootOwnership,
) {
  return createAcceptancePlan({
    repositoryRoot: "/source/docsfab",
    workspaceRoot: "/tmp/acceptance/source",
    fixtureRoot: "/tmp/acceptance/fixture",
    stateDirectory: "/operator/state/run",
    evidenceDirectory: "/operator/evidence/run",
    acceptanceId: "acceptance-test",
    revision: "a".repeat(40),
    sourceTree: "b".repeat(40),
    live,
    judge,
    judgeProfileStatus: judge ? "current" : "unknown",
    now: new Date("2026-08-03T12:00:00.000Z"),
    offlineEnvironment: offlineAcceptanceEnvironment({}, "/operator/state/run"),
    localEnvironment: { PATH: "/bin", JUDGE_ENABLED: "false" },
    policyEnvironment: { ...validModelEnvironment, JUDGE_ENABLED: "false" },
    judgeEnvironment: {
      ...validModelEnvironment,
      JUDGE_ENABLED: "true",
      JUDGE_API_KEY: "judge-secret",
    },
    offlineCommandPrefix: commandPrefix,
    localCommandPrefix: commandPrefix,
    ...(hostRootOwner ? { hostRootOwner } : {}),
  });
}

describe("MVP acceptance plan", () => {
  it("keeps every networked phase behind an explicit gate", () => {
    const phases = plan();

    expect(phases.filter((phase) => phase.networked)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "live-doctor", enabled: false }),
        expect.objectContaining({ id: "live-fixture-readiness", enabled: false }),
        expect.objectContaining({ id: "live-self-readiness", enabled: false }),
        expect.objectContaining({ id: "judge-smoke", enabled: false }),
      ]),
    );
    expect(phases.filter((phase) => !phase.networked).every((phase) => phase.enabled)).toBe(true);
  });

  it("uses offline-only installation and a credential-free doctor profile", () => {
    const environment = offlineAcceptanceEnvironment(
      {
        NPM_TOKEN: "must-be-removed",
        GITHUB_PAT: "non-denylist-name",
        CI_JOB_JWT: "another-non-denylist-name",
        HOME: "/operator",
        PATH: "/bin",
      },
      "/operator/state/run",
    );
    const phases = createAcceptancePlan({
      repositoryRoot: "/source/docsfab",
      workspaceRoot: "/tmp/acceptance/source",
      fixtureRoot: "/tmp/acceptance/fixture",
      stateDirectory: "/operator/state/run",
      evidenceDirectory: "/operator/evidence/run",
      acceptanceId: "acceptance-test",
      revision: "a".repeat(40),
      sourceTree: "b".repeat(40),
      live: false,
      judge: false,
      judgeProfileStatus: "unknown",
      now: new Date("2026-08-03T12:00:00.000Z"),
      offlineEnvironment: environment,
      localEnvironment: { PATH: "/bin", JUDGE_ENABLED: "false" },
      policyEnvironment: { ...validModelEnvironment, JUDGE_ENABLED: "false" },
      judgeEnvironment: validModelEnvironment,
    });
    const install = phases.find((phase) => phase.id === "clean-install");
    const doctor = phases.find((phase) => phase.id === "offline-doctor");

    expect(install?.commands[0]).toMatchObject({
      file: "npm",
      args: ["ci", "--offline", "--ignore-scripts"],
      environment: expect.objectContaining({ npm_config_offline: "true" }),
    });
    expect(doctor?.commands[0]?.environment).toMatchObject({
      MODEL_BASE_URL: "https://offline.invalid/v1",
      MODEL_API_KEY: "offline-placeholder-not-a-credential",
      JUDGE_ENABLED: "false",
    });
    expect(doctor?.commands[0]?.environment.NPM_TOKEN).toBeUndefined();
    expect(doctor?.commands[0]?.environment.GITHUB_PAT).toBeUndefined();
    expect(doctor?.commands[0]?.environment.CI_JOB_JWT).toBeUndefined();
    expect(doctor?.commands[0]?.environment.HOME).toBeUndefined();
  });

  it("runs self-readiness against the exact commit without scanner exemptions", () => {
    const phase = plan(true).find((candidate) => candidate.id === "live-self-readiness");
    const args = phase?.commands[0]?.args ?? [];

    // The whole-repository scan is advisory only: the live self-run carries the
    // exact tested commit and no scanner override ceremony.
    expect(args).toContain("a".repeat(40));
    expect(args).not.toContain("--scanner-override-rule");
    expect(args).not.toContain("--scanner-override-reason");
    expect(args).not.toContain("--scanner-override-expires-at");
  });

  it("keeps local, policy-model, and judge subprocess credentials separated", () => {
    const phases = plan(true, true);
    const fixture = phases.find((candidate) => candidate.id === "live-fixture-readiness");
    const policy = phases.filter((candidate) =>
      ["live-doctor", "live-fixture-readiness", "live-self-readiness"].includes(candidate.id),
    );
    const judge = phases.find((candidate) => candidate.id === "judge-smoke");

    for (const command of fixture?.commands.slice(0, 6) ?? []) {
      expect(Object.keys(command.environment)).not.toEqual(
        expect.arrayContaining(["MODEL_API_KEY", "JUDGE_API_KEY"]),
      );
    }
    for (const phase of policy) {
      for (const command of phase.commands.filter((item) => item.file === "node")) {
        expect(command.environment.MODEL_API_KEY).toBeDefined();
        expect(command.environment.JUDGE_API_KEY).toBeUndefined();
        expect(command.environment.JUDGE_ENABLED).toBe("false");
      }
    }
    expect(judge?.commands[0]?.environment.JUDGE_API_KEY).toBe("judge-secret");
    expect(judge?.commands[0]?.environment.JUDGE_ENABLED).toBe("true");
  });

  it("runs offline checks and fixture Git setup inside the deny-network prefix", () => {
    const phases = plan(true, false, ["deny-network", "--"]);
    const offlineCommands = phases
      .filter((phase) => !phase.networked)
      .flatMap((phase) => phase.commands);
    const fixtureGit = phases
      .find((phase) => phase.id === "live-fixture-readiness")!
      .commands.slice(0, 6);

    for (const command of [...offlineCommands, ...fixtureGit]) {
      expect(command.file).toBe("deny-network");
      expect(command.args[0]).toBe("--");
    }
    expect(phases.find((phase) => phase.id === "check")?.commands[0]?.diagnosticProfile).toBe(
      "runtime-check",
    );
    for (const phase of phases.filter((candidate) => candidate.id !== "check")) {
      for (const command of phase.commands) {
        expect(command.diagnosticProfile).toBeUndefined();
      }
    }
  });

  it("plans every workflow in the current catalog", () => {
    const catalog = plan().find((phase) => phase.id === "catalog");
    const planned = catalog?.commands
      .filter((command) => command.args.includes("plan"))
      .map((command) => command.args.at(-1));

    expect(planned).toEqual(listWorkflows().map((workflow) => workflow.name));
  });

  it("names the measured check limitations in the check phase environment only", () => {
    const phases = plan(false, false, ["deny-network", "--"], { outside: 0, inside: 65534 });
    const check = phases.find((phase) => phase.id === "check")!;

    expect(check.commands[0]?.environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]).toBe(
      "host-uid-view,registry-metadata",
    );
    expect(check.limitations).toEqual([...ACCEPTANCE_CHECK_LIMITATIONS]);
    // Positive control: every other offline phase keeps its environment unchanged.
    for (const phase of phases.filter((candidate) => candidate.id !== "check")) {
      for (const command of phase.commands) {
        expect(command.environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]).toBeUndefined();
      }
    }
  });

  it("keeps the ownership-bound files in a sandbox that shows the host owner of /", () => {
    const check = plan(false, false, ["deny-network", "--"], { outside: 0, inside: 0 }).find(
      (phase) => phase.id === "check",
    )!;

    expect(check.commands[0]?.environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]).toBe(
      "registry-metadata",
    );
    expect(check.limitations?.map((limitation) => limitation.file)).toEqual([
      "test/packed-profile-probe.test.ts",
    ]);
  });

  it("runs every check file when the check phase is not network-denied", () => {
    const check = plan().find((phase) => phase.id === "check")!;

    expect(check.commands[0]?.environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]).toBeUndefined();
    expect(check.limitations).toEqual([]);
  });

  it("asks each networked DocsFab command, and no other command, for a JSON failure report", () => {
    const phases = plan(true, true, ["deny-network", "--"]);
    const reporting = phases
      .filter((phase) => phase.networked)
      .flatMap((phase) =>
        phase.commands
          .filter((command) => command.file === "node")
          .map((command) => [phase.id, command.args[0], command.args.at(-1)]),
      );

    expect(reporting).toEqual([
      ["live-doctor", "dist/acceptance-export-doctor.js", "--json"],
      ["live-fixture-readiness", "dist/cli.js", "--json"],
      ["live-self-readiness", "dist/cli.js", "--json"],
      ["judge-smoke", "dist/acceptance-judge.js", "--json"],
    ]);
    // Positive control: offline commands, including the offline doctor, and the
    // fixture's Git setup keep the human output a failed offline phase keeps.
    for (const phase of phases) {
      for (const command of phase.commands) {
        if (phase.networked && command.file === "node") continue;
        expect(command.args, `${phase.id}: ${command.args.join(" ")}`).not.toContain("--json");
      }
    }
  });
});

describe("MVP acceptance terminal states", () => {
  it("records passes and gated skips without invoking a fake provider", async () => {
    const calls: AcceptanceCommand[] = [];
    const results = await executeAcceptancePlan(
      plan(),
      async (command) => {
        calls.push(command);
        return { exitCode: 0 };
      },
      { commit: "a".repeat(40), modelProfileStatus: "unknown" },
    );

    expect(results.filter((result) => result.status === "passed")).toHaveLength(5);
    expect(results.filter((result) => result.status === "skipped")).toHaveLength(4);
    expect(calls.every((call) => !call.args.includes("--live"))).toBe(true);
  });

  it.each([
    "clean-install",
    "check",
    "build",
    "catalog",
    "offline-doctor",
    "live-doctor",
    "live-fixture-readiness",
    "live-self-readiness",
    "judge-smoke",
  ] as const)("fails closed when %s exits nonzero", async (failedPhase) => {
    const phases = plan(true, true);
    for (const phaseCommand of phases.find((phase) => phase.id === "check")!.commands) {
      phaseCommand.cwd = process.cwd();
    }
    let currentPhase = "";
    const commandToPhase = new Map<AcceptanceCommand, string>();
    for (const phase of phases) {
      for (const phaseCommand of phase.commands) {
        commandToPhase.set(phaseCommand, phase.id);
      }
    }
    const results = await executeAcceptancePlan(
      phases,
      async (phaseCommand) => {
        currentPhase = commandToPhase.get(phaseCommand) ?? "";
        return {
          exitCode: currentPhase === failedPhase ? 1 : 0,
          ...(currentPhase === "check"
            ? {
                diagnostic: {
                  termination: "exit" as const,
                  script: "test",
                  testFile: "test/acceptance.test.ts",
                },
              }
            : {}),
        };
      },
      {
        commit: "a".repeat(40),
        modelProfileStatus: "current",
        judgeProfileStatus: "current",
      },
    );

    expect(results.find((result) => result.id === failedPhase)).toMatchObject({
      status: "failed",
      commit: "a".repeat(40),
      modelProfileStatus: "current",
    });
    if (failedPhase === "check") {
      expect(results.find((result) => result.id === "check")?.diagnostic).toEqual({
        termination: "exit",
        script: "test",
        testFile: "test/acceptance.test.ts",
      });
    }
    const failureIndex = results.findIndex((result) => result.id === failedPhase);
    expect(results.slice(failureIndex + 1).filter((result) => result.status !== "skipped")).toEqual(
      [],
    );
  });

  it("discards arbitrary check output from injected diagnostic metadata", async () => {
    const phases = plan();
    const results = await executeAcceptancePlan(
      phases,
      async (phaseCommand) =>
        phaseCommand.args.includes("check")
          ? {
              exitCode: 1,
              diagnostic: {
                termination: "signal",
                signal: "MODEL_API_KEY=untrusted" as NodeJS.Signals,
                script: "private-secret",
                testFile: "test/private-secret.test.ts",
              },
            }
          : { exitCode: 0 },
      { commit: "a".repeat(40), modelProfileStatus: "unknown" },
    );

    const diagnostic = results.find((result) => result.id === "check")?.diagnostic;
    expect(diagnostic).toEqual({ termination: "signal" });
    expect(JSON.stringify(diagnostic)).not.toContain("MODEL_API_KEY");
    expect(JSON.stringify(diagnostic)).not.toContain("private-secret");
  });
});

describe("acceptance gates and manifest", () => {
  it("requires exact, independent model and judge destination approvals", () => {
    const environment = {
      ...validModelEnvironment,
      DOCSFAB_ACCEPTANCE_LIVE: "true",
      DOCSFAB_ACCEPTANCE_JUDGE: "true",
      JUDGE_BASE_URL: "https://judge.example.test/v1",
    };
    expect(() =>
      validateAcceptanceGates({
        live: true,
        judge: false,
        approvedModelUrl: "https://wrong.example.test/v1",
        environment,
      }),
    ).toThrow("exactly matching MODEL_BASE_URL");
    expect(() =>
      validateAcceptanceGates({
        live: true,
        judge: true,
        approvedModelUrl: validModelEnvironment.MODEL_BASE_URL,
        approvedJudgeUrl: "https://wrong.example.test/v1",
        environment,
      }),
    ).toThrow("exactly matching JUDGE_BASE_URL");
    expect(() =>
      validateAcceptanceGates({
        live: true,
        judge: true,
        approvedModelUrl: validModelEnvironment.MODEL_BASE_URL,
        approvedJudgeUrl: "https://judge.example.test/v1/",
        environment,
      }),
    ).not.toThrow();
  });

  it.each([
    ["http://inference.example.test/v1", "must use HTTPS"],
    ["https://operator:secret@inference.example.test/v1", "embedded credentials"],
    ["https://inference.example.test/v1?api_key=secret", "query string or fragment"],
    ["https://inference.example.test/v1#secret", "query string or fragment"],
  ])("rejects an unsafe approved model URL %s", (url, message) => {
    expect(() =>
      validateAcceptanceGates({
        live: true,
        judge: false,
        approvedModelUrl: url,
        environment: {
          ...validModelEnvironment,
          DOCSFAB_ACCEPTANCE_LIVE: "true",
          MODEL_BASE_URL: url,
        },
      }),
    ).toThrow(message);
  });

  it.each([
    ["https://operator:secret@judge.example.test/v1", "embedded credentials"],
    ["https://judge.example.test/v1?api_key=secret", "query string or fragment"],
    ["https://judge.example.test/v1#secret", "query string or fragment"],
  ])("rejects an unsafe judge destination %s", (url, message) => {
    expect(() =>
      validateAcceptanceGates({
        live: true,
        judge: true,
        approvedModelUrl: validModelEnvironment.MODEL_BASE_URL,
        approvedJudgeUrl: url,
        environment: {
          ...validModelEnvironment,
          DOCSFAB_ACCEPTANCE_LIVE: "true",
          DOCSFAB_ACCEPTANCE_JUDGE: "true",
          JUDGE_BASE_URL: url,
        },
      }),
    ).toThrow(message);
  });

  it("minimizes run records without paths, summaries, or raw output", () => {
    const acceptanceModel = createModelEvidence(validModelConfig);
    const summary = summarizeAcceptanceRunRecord(
      {
        id: "run-1",
        workflow: "readiness",
        status: "succeeded",
        repository: {
          sourcePath: "/private/source",
          revision: "a".repeat(40),
        },
        instruction: "private instruction",
        steps: [{ summary: "raw model output" }],
        securityScan: {
          findings: [{ path: "private.env", ruleId: "credential.assigned-secret" }],
        },
        securityScanEffectiveDisposition: { status: "authorized" },
        models: [acceptanceModel],
      },
      "run-1.json",
      "b".repeat(64),
    );
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      revision: "a".repeat(40),
      scanDisposition: "authorized",
      ruleIds: ["credential.assigned-secret"],
      sha256: "b".repeat(64),
      models: [
        {
          provider: acceptanceModel.provider,
          model: acceptanceModel.model,
          profileSha256: acceptanceModel.profile!.sha256,
        },
      ],
    });
    expect(serialized).not.toContain("/private/source");
    expect(serialized).not.toContain("private.env");
    expect(serialized).not.toContain("private instruction");
    expect(serialized).not.toContain("raw model output");
  });

  it.each([
    [{ id: "../private" }, "run id"],
    [{ id: "run\nprivate" }, "run id"],
    [{ workflow: "private/workflow" }, "workflow"],
    [{ status: { raw: "private" } }, "run status"],
    [{ repository: { revision: "/private/revision" } }, "repository revision"],
    [{ models: [{ provider: "provider\nsecret", model: "model" }] }, "provider"],
    [{ models: [{ provider: "provider", model: "../../private" }] }, "model identity"],
    [{ securityScan: { findings: [{ ruleId: "../private" }] } }, "rule id"],
  ])("rejects malformed summary identities %#", (override, message) => {
    const record = {
      id: "run-1",
      workflow: "readiness",
      status: "succeeded",
      repository: { revision: "a".repeat(40) },
      securityScan: { findings: [] },
      securityScanEffectiveDisposition: { status: "passed" },
      models: [{ provider: "provider", model: "model" }],
      ...override,
    };
    expect(() =>
      summarizeAcceptanceRunRecord(
        record,
        !("id" in override) || override.id === undefined
          ? "run-1.json"
          : `${String(override.id)}.json`,
        "b".repeat(64),
      ),
    ).toThrow(message);
  });

  it("binds judge evidence to the invocation, commit, profile, and record digests", () => {
    const records = [
      summarizeAcceptanceRunRecord(
        {
          id: "one",
          workflow: "readiness",
          status: "succeeded",
          repository: { revision: "a".repeat(40) },
          models: [{ provider: "provider", model: "model" }],
        },
        "one.json",
        "1".repeat(64),
      ),
      summarizeAcceptanceRunRecord(
        {
          id: "two",
          workflow: "readiness",
          status: "succeeded",
          repository: { revision: "b".repeat(40) },
          models: [{ provider: "provider", model: "model" }],
        },
        "two.json",
        "2".repeat(64),
      ),
    ];
    const artifact = {
      schemaVersion: 1,
      acceptanceId: "acceptance-test",
      testedCommit: "a".repeat(40),
      judgeProfileStatus: "current",
      inputRecords: records.map(({ id, sha256 }) => ({ id, sha256 })),
      fixture: { name: "MVP live readiness acceptance", version: 1 },
      structural: { passed: true, recordCount: 2 },
      judge: {
        status: "passed",
        rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
        model: { provider: "judge", model: "model" },
        score: 0.9,
      },
    };
    const input = {
      sha256: "c".repeat(64),
      acceptanceId: "acceptance-test",
      revision: "a".repeat(40),
      judgeProfileStatus: "current" as const,
      records,
    };

    expect(bindAcceptanceJudgeEvidence(artifact, input)).toMatchObject({
      sha256: "c".repeat(64),
      acceptanceId: "acceptance-test",
      testedCommit: "a".repeat(40),
    });
    // A legacy artifact saved with a stale judge profile still binds.
    expect(
      bindAcceptanceJudgeEvidence(
        { ...artifact, judgeProfileStatus: "stale" },
        { ...input, judgeProfileStatus: "stale" },
      ),
    ).toMatchObject({ acceptanceId: "acceptance-test", judgeProfileStatus: "stale" });
    expect(
      bindAcceptanceJudgeEvidence({ ...artifact, testedCommit: "d".repeat(40) }, input),
    ).toBeUndefined();
    expect(
      bindAcceptanceJudgeEvidence(
        {
          ...artifact,
          judge: { ...artifact.judge, rawOutput: "must not be retained" },
        },
        input,
      ),
    ).toBeUndefined();
    expect(
      bindAcceptanceJudgeEvidence({ ...artifact, rawOutput: "must not be retained" }, input),
    ).toBeUndefined();
    expect(
      bindAcceptanceJudgeEvidence(
        {
          ...artifact,
          inputRecords: artifact.inputRecords.map((record, index) =>
            index === 0 ? { ...record, raw: "must not be retained" } : record,
          ),
        },
        input,
      ),
    ).toBeUndefined();
    expect(
      bindAcceptanceJudgeEvidence(
        { ...artifact, structural: { passed: false, recordCount: 2 } },
        input,
      ),
    ).toBeUndefined();
    expect(
      bindAcceptanceJudgeEvidence(
        { ...artifact, structural: { passed: true, recordCount: 1 } },
        input,
      ),
    ).toBeUndefined();
  });

  it("rejects duplicate judge record identities", () => {
    const record = summarizeAcceptanceRunRecord(
      {
        id: "one",
        workflow: "readiness",
        status: "succeeded",
        repository: { revision: "a".repeat(40) },
        models: [{ provider: "provider", model: "model" }],
      },
      "one.json",
      "1".repeat(64),
    );
    const artifact = {
      schemaVersion: 1,
      acceptanceId: "acceptance-test",
      testedCommit: "a".repeat(40),
      judgeProfileStatus: "current",
      inputRecords: [
        { id: "one", sha256: "1".repeat(64) },
        { id: "one", sha256: "1".repeat(64) },
      ],
      fixture: { name: "MVP live readiness acceptance", version: 1 },
      structural: { passed: true, recordCount: 2 },
      judge: {
        status: "passed",
        rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
        model: { provider: "judge", model: "model" },
        score: 0.9,
      },
    };

    expect(
      bindAcceptanceJudgeEvidence(artifact, {
        sha256: "c".repeat(64),
        acceptanceId: "acceptance-test",
        revision: "a".repeat(40),
        judgeProfileStatus: "current",
        records: [record, record],
      }),
    ).toBeUndefined();
  });

  it("rejects output roots that alias the source through a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docsfab-output-root-"));
    const repository = join(directory, "repository");
    const operator = join(directory, "operator");
    await mkdir(repository);
    await mkdir(operator);
    await symlink(repository, join(operator, "alias"));
    try {
      await expect(
        canonicalizeAcceptanceOutputRoot(
          join(operator, "alias", "state"),
          repository,
          "--state-dir",
        ),
      ).rejects.toThrow("symbolic links");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("collectable acceptance evidence boundary", () => {
  async function layout() {
    const directory = await mkdtemp(join(await realpath(tmpdir()), "docsfab-collectable-"));
    const repository = join(directory, "repository");
    const state = join(directory, "operator", "state");
    const evidence = join(directory, "operator", "evidence");
    await mkdir(repository);
    await mkdir(state, { recursive: true });
    await mkdir(evidence, { recursive: true });
    return { directory, repository, state, evidence, privateRoots: [state, evidence] };
  }

  it("accepts a destination inside the repository while private roots stay outside-only", async () => {
    const paths = await layout();
    const inside = join(paths.repository, "ci-results", "live-model");
    try {
      await expect(
        canonicalizeCollectableEvidenceDestination({
          requestedPath: inside,
          privateRoots: paths.privateRoots,
          label: "--collect-dir",
        }),
      ).resolves.toBe(inside);
      // The same path is still refused as an output root for private state and
      // raw run records.
      for (const label of ["--state-dir", "--evidence-dir"]) {
        await expect(
          canonicalizeAcceptanceOutputRoot(inside, paths.repository, label),
        ).rejects.toThrow(`${label} must be outside the source repository.`);
        await expect(
          canonicalizeAcceptanceOutputRoot(paths.repository, paths.repository, label),
        ).rejects.toThrow("must be outside the source repository");
      }
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  });

  it("refuses destinations that overlap a private root in either direction", async () => {
    const paths = await layout();
    try {
      for (const requestedPath of [
        paths.state,
        join(paths.state, "collect"),
        join(paths.evidence, "collect"),
        join(paths.directory, "operator"),
        paths.directory,
      ]) {
        await expect(
          canonicalizeCollectableEvidenceDestination({
            requestedPath,
            privateRoots: paths.privateRoots,
            label: "--collect-dir",
          }),
        ).rejects.toThrow("must be disjoint from the private");
      }
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  });

  it("refuses destinations that traverse symbolic links", async () => {
    const paths = await layout();
    await symlink(paths.state, join(paths.repository, "alias"));
    try {
      await expect(
        canonicalizeCollectableEvidenceDestination({
          requestedPath: join(paths.repository, "alias", "collect"),
          privateRoots: paths.privateRoots,
          label: "--collect-dir",
        }),
      ).rejects.toThrow("does not traverse symbolic links");
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  });

  it("refuses evidence carrying credential values, credential shapes, or private roots", () => {
    const secret = "collectable-secret-value-0123456789";
    const input = {
      environment: { MODEL_API_KEY: secret, CI_JOB_TOKEN: "ci-job-token-value", PATH: "/usr/bin" },
      privateRoots: ["/operator/state"],
      label: "--collect-dir",
    };
    expect(() =>
      assertCollectableAcceptanceEvidence({ passed: true, records: [] }, input),
    ).not.toThrow();
    for (const [value, message] of [
      [{ note: secret }, "value of MODEL_API_KEY"],
      [{ note: "ci-job-token-value" }, "value of CI_JOB_TOKEN"],
      [{ note: `nvapi-${"a".repeat(32)}` }, "credential-shaped material"],
      [{ note: "/operator/state/run/record.json" }, "private root location"],
    ] as const) {
      let error: unknown;
      try {
        assertCollectableAcceptanceEvidence(value, input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain("ci-job-token-value");
    }
  });
});

describe("failed phase output sanitizing", () => {
  const collect = (output: string) => () =>
    assertCollectableAcceptanceEvidence(
      { output },
      { environment: {}, privateRoots: [], label: "--collect-dir" },
    );

  it("replaces a credential value in its JSON-escaped form too", () => {
    const value = 'quote"d-probe-value-0123';
    const escaped = JSON.stringify(value).slice(1, -1);
    expect(
      sanitizeAcceptancePhaseOutput(`raw ${value} and escaped ${escaped}`, {
        environment: { PROBE_TOKEN: value },
        privateRoots: [],
      }),
    ).toBe("raw [redacted PROBE_TOKEN] and escaped [redacted PROBE_TOKEN]");
  });

  it("withholds lines the collection screen flags only in serialized form, alone or as a pair", () => {
    const value = ["Zq", "8vLm", "3RtY", "6pWn", "2KxB", "9sDf"].join("");
    // Clean as raw text; escaping the quotes makes the collection screen flag it.
    const single = ['id: "author', 'ization:managed-state",'].join("");
    // Each line is clean alone; serialized together they read as an assignment.
    const pair = ["password='", value];
    const text = ["kept before", single, "kept between", ...pair, "kept after"].join("\n");
    // Positive control: the screen refuses the unsanitized text.
    expect(collect(text)).toThrow("credential-shaped material");

    const sanitized = sanitizeAcceptancePhaseOutput(text, { environment: {}, privateRoots: [] });
    expect(sanitized.split("\n")).toEqual([
      "kept before",
      ACCEPTANCE_WITHHELD_LINE,
      "kept between",
      ACCEPTANCE_WITHHELD_LINE,
      ACCEPTANCE_WITHHELD_LINE,
      "kept after",
    ]);
    expect(collect(sanitized)).not.toThrow();
  });
});

describe("networked phase failure summary", () => {
  const base = {
    acceptanceId: "acceptance-test",
    testedCommit: "a".repeat(40),
    phase: "live-doctor" as AcceptancePhase["id"],
    exitCode: 1,
    stdout: "",
    stderr: "",
    environment: {} as NodeJS.ProcessEnv,
    privateRoots: ["/operator/state", "/operator/evidence"],
  };
  const head = {
    schemaVersion: 1,
    acceptanceId: "acceptance-test",
    testedCommit: "a".repeat(40),
    phase: "live-doctor",
    exitCode: 1,
  };
  const summaryOf = (fields: Partial<typeof base>) =>
    summarizeNetworkedPhaseFailure({ ...base, ...fields });
  /** An operator failure envelope as `--json` prints it, with a message the summary never keeps. */
  const envelope = (fields: Record<string, unknown>) =>
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "docsfab-operator-error",
        message: "Provider detail stays out of the summary.",
        ...fields,
      },
      null,
      2,
    );
  const runResult = (failures: unknown[]) =>
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "docsfab-run-result",
        execution: { runId: "run-1", workflow: "readiness", status: "failed", exitCode: 1 },
        failures,
        nextSteps: ["docsfab runs show run-1"],
      },
      null,
      2,
    );
  const runFailure = { scope: "run", class: "infrastructure", layer: "inference" };

  it("reads the last operator envelope a command printed and skips any other text", () => {
    const stderr = [
      "PREFLIGHT",
      envelope({ code: "earlier-failure" }),
      "{",
      "a stray brace line is not an object",
      "{",
      '  "kind": "docsfab-operator-error",',
      '  "code": "malformed-block",',
      "}",
      envelope({
        code: "provider-credentials-missing",
        failure: { class: "auth", layer: "cli", code: "provider-credentials-missing" },
        nextAction: "Run docsfab setup, then rerun.",
        docsAnchor: "docs/reference/operations/doctor.md#provider",
      }),
      "(node:1) Warning: printed after the report",
    ].join("\n");

    expect(summaryOf({ stderr })).toEqual({
      ...head,
      report: "operator-error",
      code: "provider-credentials-missing",
      failure: { class: "auth", layer: "cli", code: "provider-credentials-missing" },
      nextAction: "Run docsfab setup, then rerun.",
      docsAnchor: "docs/reference/operations/doctor.md#provider",
    });
  });

  it("reads a compact one-line envelope and keeps none of its message", () => {
    const stderr = `${JSON.stringify({
      schemaVersion: 1,
      kind: "docsfab-operator-error",
      code: "saved-run-not-found",
      message: "The requested saved run record was not found in /operator/state/run.",
    })}\n`;

    expect(summaryOf({ stderr })).toEqual({
      ...head,
      report: "operator-error",
      code: "saved-run-not-found",
    });
  });

  it("prefers the operator envelope, the command's final word, to a run result", () => {
    const summary = summaryOf({
      stdout: runResult([{ ...runFailure, code: "provider-network" }]),
      stderr: envelope({ code: "publication-failed" }),
    });

    expect(summary).toMatchObject({ report: "operator-error", code: "publication-failed" });
  });

  it("reads the run-scope failure of a run result, not a retried attempt's", () => {
    const summary = summaryOf({
      phase: "live-self-readiness",
      stdout: `a line before the result\n${runResult([
        {
          scope: "attempt",
          stepId: "assess-readiness",
          attempt: 1,
          class: "flake",
          layer: "inference",
          code: "provider-rate-limited",
        },
        { ...runFailure, code: "provider-network" },
        { ...runFailure, scope: "step", stepId: "assess-readiness", code: "provider-network" },
      ])}\n`,
      stderr: "progress on standard error\n",
    });

    expect(summary).toEqual({
      ...head,
      phase: "live-self-readiness",
      report: "run-result",
      code: "provider-network",
      failure: { class: "infrastructure", layer: "inference", code: "provider-network" },
    });
  });

  it("reads the run failure from the run result a failed `docsfab run --json` prints", () => {
    const record = {
      schemaVersion: 2,
      id: "run-fixture-1",
      workflow: "readiness",
      repository: {
        sourcePath: "/tmp/acceptance/fixture",
        requestedRevision: "HEAD",
        revision: "b".repeat(40),
      },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "failed",
      createdAt: "2026-10-14T12:00:00.000Z",
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [],
      failure: { class: "infrastructure", layer: "inference", code: "provider-network" },
    } as unknown as RunRecord;
    // The run result builder and serializer `docsfab run --json` prints with.
    const stdout = serializeRunResultV1(
      buildRunResultV1({
        record,
        recordPath: "/operator/state/run/run-fixture-1.json",
        exitCode: 1,
        repositoryPath: "/tmp/acceptance/fixture",
      }),
    );

    expect(summaryOf({ phase: "live-fixture-readiness", stdout })).toEqual({
      ...head,
      phase: "live-fixture-readiness",
      report: "run-result",
      code: "provider-network",
      failure: { class: "infrastructure", layer: "inference", code: "provider-network" },
    });
  });

  it.each([
    ["only raw text", { stdout: "raw provider detail", stderr: "fatal: not a git repository" }],
    [
      "a run result with no run-scope failure",
      {
        stdout: runResult([
          { scope: "attempt", class: "flake", layer: "inference", code: "provider-rate-limited" },
        ]),
      },
    ],
    ["an envelope whose code is not a code", { stderr: envelope({ code: "Not A Code" }) }],
    [
      "an envelope of another schema version",
      { stderr: envelope({ schemaVersion: 2, code: "provider-credentials-missing" }) },
    ],
  ])("names no code when the command printed %s", (_name, fields) => {
    expect(summaryOf(fields)).toEqual({ ...head, report: "none" });
  });

  it.each([
    [
      "an operator envelope",
      { stderr: envelope({ code: "provider-credentials-missing" }) },
      "operator-error",
    ],
    [
      "a run result",
      { stdout: runResult([{ ...runFailure, code: "provider-network" }]) },
      "run-result",
    ],
    ["nothing it reports", { stderr: "fatal: unable to auto-detect the email address" }, "none"],
  ])("keeps the exit status the command exited with after %s", (_name, fields, report) => {
    // A command's own status is not always 1: a failed Git command exits 128.
    for (const exitCode of [2, 128]) {
      expect(summaryOf({ ...fields, exitCode })).toMatchObject({ ...head, exitCode, report });
    }
  });

  it.each(["live-doctor", "live-fixture-readiness", "live-self-readiness", "judge-smoke"] as const)(
    "names the %s phase it summarizes",
    (phase) => {
      expect(summaryOf({ phase })).toEqual({ ...head, phase, report: "none" });
    },
  );

  it("keeps the code but not a failure classification outside the closed vocabulary", () => {
    const stderr = envelope({
      code: "operator-error",
      failure: { class: "made-up", layer: "cli", code: "operator-error" },
    });

    expect(summaryOf({ stderr })).toEqual({
      ...head,
      report: "operator-error",
      code: "operator-error",
    });
  });

  it("passes every collected string of an envelope through the phase-output sanitizer", () => {
    const shaped = `nvapi-${"p".repeat(32)}`;
    // A code equal to a credential value is contrived, but no field is trusted.
    const environment = { MODEL_API_KEY: "model-key-value-0123", LEAKY_TOKEN: "provider-network" };
    const stderr = envelope({
      code: "provider-network",
      failure: { class: "infrastructure", layer: "cli", code: "provider-network" },
      nextAction: "Rotate model-key-value-0123, then read /operator/state/run/record.json.",
      docsAnchor: `docs/provider.md ${shaped}`,
    });
    // Positive control: the printed report carries each value.
    expect(stderr).toContain("model-key-value-0123");
    expect(stderr).toContain(shaped);

    const summary = summaryOf({ environment, stderr });
    expect(summary).toMatchObject({
      report: "operator-error",
      code: "[redacted LEAKY_TOKEN]",
      failure: { class: "infrastructure", layer: "cli", code: "[redacted LEAKY_TOKEN]" },
      nextAction: "Rotate [redacted MODEL_API_KEY], then read [private root]/run/record.json.",
    });
    expect(summary.docsAnchor).toMatch(/^docs\/provider\.md /u);
    const serialized = JSON.stringify(summary);
    for (const fragment of ["model-key-value-0123", "p".repeat(32), "Provider detail"]) {
      expect(serialized).not.toContain(fragment);
    }
    expect(() =>
      assertCollectableAcceptanceEvidence(summary, {
        environment,
        privateRoots: base.privateRoots,
        label: "--collect-dir",
      }),
    ).not.toThrow();
  });

  it("passes the failure fields of a run result through the phase-output sanitizer too", () => {
    const environment = { CLASS_SECRET: "infrastructure", LAYER_SECRET: "inference" };
    const summary = summaryOf({
      environment,
      stdout: runResult([{ ...runFailure, code: "provider-network" }]),
    });

    expect(summary).toMatchObject({
      report: "run-result",
      code: "provider-network",
      failure: {
        class: "[redacted CLASS_SECRET]",
        layer: "[redacted LAYER_SECRET]",
        code: "provider-network",
      },
    });
  });
});
