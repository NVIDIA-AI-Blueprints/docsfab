// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  confinedOfflineIsolationCandidates,
  executeCommand,
  liveAcceptanceEnvironment,
  offlineIsolation,
  probeHostRootOwner,
  runAcceptanceCli,
  type AcceptanceCliDependencies,
  type AcceptanceCommandExecutor,
} from "../src/acceptance-cli.js";
import {
  ACCEPTANCE_CHECK_LIMITATIONS,
  ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE,
} from "../src/acceptance-check-limitations.js";
import type { AcceptanceCommand, AcceptanceCommandDiagnostic } from "../src/acceptance.js";
import {
  liveModelApproveUrl,
  prepareLiveModelCiConfig,
} from "../scripts/prepare-live-model-ci-config.js";
import { ACCEPTANCE_WITHHELD_LINE } from "../src/acceptance.js";
import { writeAcceptanceJsonExclusive } from "../src/acceptance-evidence.js";
import { inspectAcceptanceExportDoctor } from "../src/acceptance-export-doctor.js";
import { limit } from "../src/config/limits.js";
import { loadConfig, type DocsFabConfig } from "../src/config/runtime-loader.js";
import type { DoctorReadinessResult } from "../src/doctor-readiness.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";
import { reportOperatorFailure } from "../src/operator/error-envelope.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { TEST_TIMEOUT_LIMITS, vitestDefaultTimeouts } from "./helpers/test-timeouts.js";

const revision = "a".repeat(40);
const fixtureRevision = "b".repeat(40);
const sourceTree = "d".repeat(40);
const selfScanRules = [
  "credential.assigned-secret",
  "credential.aws-access-key-id",
  "credential.gitlab-token",
  "credential.nvidia-api-key",
  "credential.private-key",
].sort();
const roots = temporaryRoots();

it("confines offline validation writes to explicit disposable roots", () => {
  const darwin = confinedOfflineIsolationCandidates("darwin", ["/tmp/workspace", "/tmp/scratch"]);
  expect(darwin[0]?.join(" ")).toContain("(deny file-write*)");
  expect(darwin[0]?.join(" ")).toContain('(subpath "/tmp/workspace")');
  const linux = confinedOfflineIsolationCandidates("linux", ["/tmp/workspace"]);
  expect(linux[0]).toEqual(
    expect.arrayContaining(["--ro-bind", "/", "/", "--bind", "/tmp/workspace", "/tmp/workspace"]),
  );
});

function configuration(judge = false): DocsFabConfig {
  return {
    projectRoot: process.cwd(),
    skillCrateDirectory: join(process.cwd(), "skill-crate"),
    qualityDirectory: join(process.cwd(), "quality"),
    qualityPackDirectory: join(process.cwd(), "quality-pack"),
    stateDirectory: join(process.cwd(), ".docsfab", "runs"),
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: ["provider-transient"],
    },
    model: validModelConfig,
    ...(judge
      ? {
          judge: {
            ...validModelConfig,
            providerId: "judge-provider",
            modelId: "judge/model",
          },
        }
      : {}),
  };
}

function judgeEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(validModelEnvironment)) {
    result[name === "MODEL_ID" ? "JUDGE_MODEL_ID" : name.replace(/^MODEL_/u, "JUDGE_")] = value;
  }
  return result;
}

async function testRoot(): Promise<{
  root: string;
  stateRoot: string;
  evidenceRoot: string;
}> {
  const root = await roots.create("docsfab-acceptance-cli-test-", { realpath: true });
  return {
    root,
    stateRoot: join(root, "state"),
    evidenceRoot: join(root, "evidence"),
  };
}

interface FakeOptions {
  failArchive?: boolean;
  failBuild?: boolean;
  changeSource?: boolean;
  changeSourceHead?: boolean;
  changeSourceTree?: boolean;
  changeSourceObjectFormat?: boolean;
  malformedEvidence?: boolean;
  omitLiveRecords?: boolean;
  bindJudge?: boolean;
  /** Self record disposition that is not advisory (legacy authority-bearing). */
  selfDispositionNotAdvisory?: boolean;
  /** Self record forged with legacy override authorization. */
  selfCarriesAuthorization?: boolean;
  wrongFixtureRecordRevision?: boolean;
  mismatchedProfile?: boolean;
  /** Combined output of an `npm run check` that exits 1. */
  failCheckOutput?: string;
  failCheckDiagnostic?: AcceptanceCommandDiagnostic;
  /** Combined output of an offline export doctor that exits 1. */
  failDoctorOutput?: string;
  /** The live self-readiness run exits 1 with provider detail on its output. */
  failLiveSelf?: boolean;
  /** A networked DocsFab command exits nonzero, printing these standard streams. */
  failNetworked?: {
    phase: "live-doctor" | "live-fixture-readiness" | "live-self-readiness" | "judge-smoke";
    /** The exit status; 1 when omitted. */
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };
  /** The fixture's `git commit` exits with this status, printing this on standard error. */
  failFixtureCommit?: { exitCode: number; stderr: string };
  /** The harness's read of the fixture commit's revision, `git rev-parse HEAD`, answers this. */
  failFixtureRevisionRead?: { exitCode: number; stdout: string };
  /** The first command of this networked phase cannot be started. */
  failNetworkedSpawn?: "live-doctor";
}

/** The networked phase a planned DocsFab command belongs to, if any. */
function networkedPhaseOf(command: AcceptanceCommand): string | undefined {
  if (command.file !== "node") return undefined;
  if (command.args[0] === "dist/acceptance-judge.js") return "judge-smoke";
  if (command.args.includes("dist/acceptance-export-doctor.js")) {
    return command.args.includes("--live") ? "live-doctor" : undefined;
  }
  if (command.args.includes("run") && command.args.includes("readiness")) {
    return command.args.includes("HEAD") ? "live-fixture-readiness" : "live-self-readiness";
  }
  return undefined;
}

function fakeExecutor(options: FakeOptions = {}): {
  execute: AcceptanceCommandExecutor;
  calls: Array<{
    file: string;
    args: string[];
    cwd: string;
    stream: boolean | undefined;
    environment: NodeJS.ProcessEnv;
  }>;
} {
  const calls: Array<{
    file: string;
    args: string[];
    cwd: string;
    stream: boolean | undefined;
    environment: NodeJS.ProcessEnv;
  }> = [];
  let sourceStatusCalls = 0;
  let sourceHeadCalls = 0;
  let sourceTreeCalls = 0;
  let sourceObjectFormatCalls = 0;
  let recordIndex = 0;
  const execute: AcceptanceCommandExecutor = async (command, stream) => {
    calls.push({
      file: command.file,
      args: command.args,
      cwd: command.cwd,
      stream,
      environment: command.environment,
    });
    // The authenticated export's git commands lead with `-c` settings, such
    // as gc.auto=0; match them on their subcommand.
    const gitArgs = command.file === "git" ? withoutLeadingGitConfig(command.args) : command.args;
    if (
      options.failFixtureCommit &&
      command.file === "git" &&
      gitArgs[0] === "commit" &&
      command.cwd.endsWith("/fixture")
    ) {
      const { exitCode, stderr } = options.failFixtureCommit;
      return { exitCode, stdout: "", stderr, output: stderr };
    }
    if (command.file === "git" && gitArgs[0] === "rev-parse") {
      if (
        options.failFixtureRevisionRead &&
        gitArgs[1] === "HEAD" &&
        command.cwd.endsWith("/fixture")
      ) {
        return options.failFixtureRevisionRead;
      }
      if (gitArgs[1] === "--show-toplevel") {
        return { exitCode: 0, stdout: `${command.cwd}\n` };
      }
      if (gitArgs[1] === "--show-object-format") {
        if (command.cwd === process.cwd()) sourceObjectFormatCalls += 1;
        return {
          exitCode: 0,
          stdout:
            options.changeSourceObjectFormat &&
            command.cwd === process.cwd() &&
            sourceObjectFormatCalls > 1
              ? "sha256\n"
              : "sha1\n",
        };
      }
      if (gitArgs[1] === "HEAD^{tree}") {
        if (command.cwd === process.cwd()) sourceTreeCalls += 1;
        return {
          exitCode: 0,
          stdout:
            options.changeSourceTree && command.cwd === process.cwd() && sourceTreeCalls > 1
              ? `${"e".repeat(40)}\n`
              : `${sourceTree}\n`,
        };
      }
      if (command.cwd === process.cwd()) sourceHeadCalls += 1;
      return {
        exitCode: 0,
        stdout: command.cwd.endsWith("/fixture")
          ? `${fixtureRevision}\n`
          : options.changeSourceHead && command.cwd === process.cwd() && sourceHeadCalls > 1
            ? `${"e".repeat(40)}\n`
            : `${revision}\n`,
      };
    }
    if (command.file === "git" && gitArgs[0] === "write-tree") {
      return { exitCode: 0, stdout: `${sourceTree}\n` };
    }
    if (command.file === "git" && command.args.includes("status")) {
      if (command.cwd === process.cwd()) sourceStatusCalls += 1;
      return {
        exitCode: 0,
        stdout:
          options.changeSource && command.cwd === process.cwd() && sourceStatusCalls > 1
            ? " M changed.ts\n"
            : "",
      };
    }
    if (command.file === "git" && command.args[0] === "archive") {
      return { exitCode: options.failArchive ? 1 : 0, stdout: "" };
    }
    if (command.file === "tar") {
      const target = command.args[command.args.indexOf("-C") + 1]!;
      const ready = join(target, "test", "fixtures", "runtime-evaluation", "repositories", "ready");
      await mkdir(ready, { recursive: true });
      await writeFile(join(ready, "README.md"), "fixture\n");
      return { exitCode: 0, stdout: "" };
    }
    if (
      options.failBuild &&
      command.file.endsWith("npm") &&
      command.args.slice(-2).join(" ") === "run build"
    ) {
      return { exitCode: 1, stdout: "raw provider detail must stay captured" };
    }
    if (
      options.failCheckOutput !== undefined &&
      command.file.endsWith("npm") &&
      command.args.slice(-2).join(" ") === "run check"
    ) {
      return {
        exitCode: 1,
        stdout: "",
        output: options.failCheckOutput,
        ...(options.failCheckDiagnostic ? { diagnostic: options.failCheckDiagnostic } : {}),
      };
    }
    if (
      options.failDoctorOutput !== undefined &&
      command.args.includes("dist/acceptance-export-doctor.js") &&
      !command.args.includes("--live")
    ) {
      return { exitCode: 1, stdout: "", output: options.failDoctorOutput };
    }
    if (options.failNetworkedSpawn && networkedPhaseOf(command) === options.failNetworkedSpawn) {
      throw Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
    }
    if (options.failNetworked && networkedPhaseOf(command) === options.failNetworked.phase) {
      const { exitCode = 1, stdout = "", stderr = "" } = options.failNetworked;
      return { exitCode, stdout, stderr, output: `${stdout}${stderr}` };
    }
    if (
      options.failLiveSelf &&
      command.file === "node" &&
      command.args.includes("run") &&
      command.args.includes("readiness") &&
      !command.args.includes("HEAD")
    ) {
      return {
        exitCode: 1,
        stdout: "raw provider detail must stay captured",
        output: "raw provider detail must stay captured",
      };
    }
    if (
      !options.omitLiveRecords &&
      command.file === "node" &&
      command.args.includes("run") &&
      command.args.includes("readiness")
    ) {
      const stateDirectory = command.environment.DOCSFAB_STATE_DIR!;
      recordIndex += 1;
      const fixtureRecord = command.args.includes("HEAD");
      // The whole-repository scan is advisory only: both the clean fixture
      // (passed) and the self run against tracked credential fixtures (blocked)
      // record `advisory` with no override authorization. Legacy
      // authority-bearing shapes are treated as forgeries.
      const forgedSelfAuthorization = {
        status: "authorized",
        overrides: selfScanRules.map((ruleId) => ({
          ruleId,
          revision,
          reason: "Reviewed acceptance fixtures",
          expiresAt: "2030-01-01T00:00:00.000Z",
          decision: "authorized",
          findingCount: 1,
        })),
      };
      const modelEvidence = createModelEvidence(validModelConfig);
      if (options.mismatchedProfile && !fixtureRecord) {
        modelEvidence.profile!.sha256 = "e".repeat(64);
      }
      await writeFile(
        join(stateDirectory, `record-${recordIndex}.json`),
        options.malformedEvidence
          ? "{"
          : JSON.stringify({
              id: `record-${recordIndex}`,
              workflow: "readiness",
              status: "succeeded",
              repository: {
                revision: fixtureRecord
                  ? options.wrongFixtureRecordRevision
                    ? "c".repeat(40)
                    : fixtureRevision
                  : revision,
              },
              securityScan: fixtureRecord
                ? { status: "passed", findings: [] }
                : {
                    status: "blocked",
                    findings: selfScanRules.map((ruleId) => ({ ruleId })),
                  },
              securityScanEffectiveDisposition: {
                status:
                  !fixtureRecord && options.selfDispositionNotAdvisory ? "passed" : "advisory",
              },
              ...(!fixtureRecord && options.selfCarriesAuthorization
                ? { securityScanAuthorization: forgedSelfAuthorization }
                : {}),
              models: [modelEvidence],
            }),
        { mode: 0o600 },
      );
    }
    if (command.file === "node" && command.args[0] === "dist/acceptance-judge.js") {
      const resultPath = command.args[command.args.indexOf("--result") + 1]!;
      const stateDirectory = command.args[command.args.indexOf("--state-dir") + 1]!;
      const acceptanceId = command.args[command.args.indexOf("--acceptance-id") + 1]!;
      const testedCommit = command.args[command.args.indexOf("--commit") + 1]!;
      const profileStatus = command.args[command.args.indexOf("--profile-status") + 1]!;
      const inputRecords = await Promise.all(
        (await readdir(stateDirectory)).sort().map(async (file) => {
          const bytes = await readFile(join(stateDirectory, file));
          const record = JSON.parse(bytes.toString()) as { id: string };
          return {
            id: record.id,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }),
      );
      await writeFile(
        resultPath,
        JSON.stringify({
          schemaVersion: 1,
          acceptanceId: options.bindJudge === false ? "wrong-run" : acceptanceId,
          testedCommit,
          judgeProfileStatus: profileStatus,
          inputRecords,
          fixture: { name: "MVP live readiness acceptance", version: 1 },
          structural: { passed: true, recordCount: 2 },
          judge: {
            status: "passed",
            rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
            model: { provider: "judge-provider", model: "judge/model" },
            score: 1,
          },
        }),
        { mode: 0o600 },
      );
    }
    return { exitCode: 0, stdout: "raw provider detail must stay captured" };
  };
  return { execute, calls };
}

function dependencies(
  execute: AcceptanceCommandExecutor,
  overrides: AcceptanceCliDependencies = {},
): AcceptanceCliDependencies {
  return {
    repositoryRoot: process.cwd(),
    environment: { PATH: process.env.PATH, HOME: process.env.HOME },
    execute,
    isolateOffline: async () => ({ commandPrefix: [] }),
    now: () => new Date("2026-08-03T12:00:00.000Z"),
    randomId: () => "12345678-0000-0000-0000-000000000000",
    log: () => {},
    ...overrides,
  };
}

function args(root: Awaited<ReturnType<typeof testRoot>>, live = false, judge = false): string[] {
  return [
    "--state-dir",
    root.stateRoot,
    "--evidence-dir",
    root.evidenceRoot,
    ...(live ? ["--live", "--approve-model-url", validModelEnvironment.MODEL_BASE_URL] : []),
    ...(judge ? ["--judge", "--approve-judge-url", validModelEnvironment.MODEL_BASE_URL] : []),
  ];
}

/** Runs a command planned under the test's `deny-network --` prefix as the bare command. */
function withoutDenyNetworkPrefix(execute: AcceptanceCommandExecutor): AcceptanceCommandExecutor {
  return (command, stream) =>
    execute(
      command.file === "deny-network"
        ? { ...command, file: command.args[1]!, args: command.args.slice(2) }
        : command,
      stream,
    );
}

/** A git argument list without its leading `-c <setting>` pairs. */
function withoutLeadingGitConfig(args: readonly string[]): readonly string[] {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args.slice(index);
}

/** A failed `docsfab run --json` result, as a readiness run prints it on standard output. */
function failedRunResultJson(code: string): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      kind: "docsfab-run-result",
      execution: { runId: "run-1", workflow: "readiness", status: "failed", exitCode: 1 },
      failures: [{ scope: "run", class: "infrastructure", layer: "inference", code }],
      nextSteps: ["docsfab runs show run-1"],
    },
    null,
    2,
  );
}

/** The operator failure envelope a networked command prints with `--json`, and the envelope itself. */
function printedOperatorEnvelope(code: string): {
  printed: string;
  envelope: ReturnType<typeof reportOperatorFailure>;
} {
  const written: string[] = [];
  const envelope = reportOperatorFailure(
    Object.assign(new Error("The provider refused the request."), { code }),
    { json: true, write: (line) => written.push(line) },
  );
  return { printed: `${written.join("\n")}\n`, envelope };
}

/**
 * One acceptance run with the live gate on, and the judge gate on when asked,
 * collected into a checkout directory as CI collects it.
 */
async function liveAcceptance(fakeOptions: FakeOptions, options: { judge?: boolean } = {}) {
  const root = await testRoot();
  const repository = join(root.root, "checkout");
  await mkdir(repository);
  const collect = join(repository, "ci-results", "live-model");
  const fake = fakeExecutor(fakeOptions);
  const logs: string[] = [];
  const result = await runAcceptanceCli(
    [...args(root, true, options.judge === true), "--collect-dir", collect],
    dependencies(fake.execute, {
      repositoryRoot: repository,
      environment: {
        ...validModelEnvironment,
        ...(options.judge
          ? { ...judgeEnvironment(), JUDGE_ENABLED: "true", DOCSFAB_ACCEPTANCE_JUDGE: "true" }
          : {}),
        DOCSFAB_ACCEPTANCE_LIVE: "true",
      },
      loadConfiguration: () => configuration(options.judge === true),
      log: (message) => logs.push(message),
    }),
  );
  const invocation = join(collect, result.acceptanceId);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
    phases: Array<{ id: string; status: string; reason?: string }>;
  };
  return {
    result,
    logs,
    calls: fake.calls,
    manifest,
    /** Each recorded phase's status, by phase id. */
    statuses: Object.fromEntries(manifest.phases.map((phase) => [phase.id, phase.status])),
    /** The collected summary, after checking its private copy is byte-identical. */
    async collectedSummary(): Promise<{ text: string; value: Record<string, unknown> }> {
      const text = await readFile(join(invocation, "networked-phase-failure.json"), "utf8");
      const privateText = await readFile(
        join(root.evidenceRoot, result.acceptanceId, "networked-phase-failure.json"),
        "utf8",
      );
      expect(privateText).toBe(text);
      return { text, value: JSON.parse(text) as Record<string, unknown> };
    },
    /** No summary in either directory, and no trace line for one. */
    async expectNoSummary(): Promise<void> {
      expect(await readdir(invocation)).toEqual(["manifest.json"]);
      expect(await readdir(join(root.evidenceRoot, result.acceptanceId))).toEqual([
        "manifest.json",
      ]);
      expect(logs.filter((message) => /networked phase failure/iu.test(message))).toEqual([]);
    },
  };
}

describe("acceptance CLI orchestration", () => {
  it("retains only the failed check script and repository test path", async () => {
    const root = await testRoot();
    const script = join(root.root, "npm");
    await mkdir(join(root.root, "test"), { recursive: true });
    await writeFile(join(root.root, "test", "acceptance-cli.test.ts"), "export {};\n");
    await writeFile(
      join(root.root, "package.json"),
      JSON.stringify({
        name: "docsfab",
        version: "1.2.3",
        scripts: { "check:pins": "true", "check:static": "true", test: "true" },
      }),
    );
    await writeFile(
      script,
      [
        "#!/bin/sh",
        "printf '%s\\n' '> docsfab@1.2.3 check'",
        "printf '%s\\n' '> npm run check:pins && npm run check:static && npm test'",
        "printf '%s\\n' '> docsfab@1.2.3 test'",
        "printf '%s\\n' ' FAIL  test/acceptance-cli.test.ts > secret-bearing title'",
        "printf '%s\\n' 'private stderr fixture' >&2",
        "exit 7",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(script, 0o700);

    const result = await executeCommand({
      file: script,
      args: ["run", "check"],
      cwd: root.root,
      environment: { PATH: process.env.PATH },
      diagnosticProfile: "runtime-check",
    });

    expect(result).toMatchObject({
      exitCode: 7,
      diagnostic: {
        termination: "exit",
        script: "test",
        testFile: "test/acceptance-cli.test.ts",
      },
    });
    expect(JSON.stringify(result.diagnostic)).not.toContain("secret-bearing title");
    expect(JSON.stringify(result.diagnostic)).not.toContain("private stderr fixture");
  });

  it("records signal termination without adding output to diagnostic fields", async () => {
    const root = await testRoot();
    const script = join(root.root, "npm");
    await writeFile(
      join(root.root, "package.json"),
      JSON.stringify({
        name: "docsfab",
        version: "1.2.3",
        scripts: { "check:pins": "true", "check:static": "true", test: "true" },
      }),
    );
    await writeFile(
      script,
      ["#!/bin/sh", "printf '%s\\n' '> docsfab@1.2.3 check:pins'", "kill -TERM $$", ""].join("\n"),
      { mode: 0o700 },
    );
    await chmod(script, 0o700);

    const result = await executeCommand({
      file: script,
      args: ["run", "check"],
      cwd: root.root,
      environment: { PATH: process.env.PATH },
      diagnosticProfile: "runtime-check",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.diagnostic).toEqual({
      termination: "signal",
      signal: "SIGTERM",
      script: "check:pins",
    });
  });

  it("ignores forged lifecycle names and non-existent test paths", async () => {
    const root = await testRoot();
    const script = join(root.root, "npm");
    await mkdir(join(root.root, "test"), { recursive: true });
    await writeFile(join(root.root, "test", "real.test.ts"), "export {};\n");
    await writeFile(
      join(root.root, "package.json"),
      JSON.stringify({ name: "docsfab", version: "1.2.3", scripts: { test: "true" } }),
    );
    await writeFile(
      script,
      [
        "#!/bin/sh",
        "printf '%s\\n' '> docsfab@1.2.3 fake'",
        "printf '%s\\n' '> docsfab@1.2.3 test'",
        "printf '%s\\n' ' FAIL  test/ghost.test.ts > private title'",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(script, 0o700);

    const result = await executeCommand({
      file: script,
      args: ["run", "check"],
      cwd: root.root,
      environment: { PATH: process.env.PATH },
      diagnosticProfile: "runtime-check",
    });

    expect(result.diagnostic).toEqual({ termination: "exit", script: "test" });
    expect(JSON.stringify(result.diagnostic)).not.toContain("fake");
    expect(JSON.stringify(result.diagnostic)).not.toContain("ghost.test.ts");
    expect(JSON.stringify(result.diagnostic)).not.toContain("private title");
  });

  it("keeps dropping an overlong diagnostic line across output chunks", async () => {
    const root = await testRoot();
    await writeFile(
      join(root.root, "package.json"),
      JSON.stringify({ name: "docsfab", version: "1.2.3", scripts: { test: "true" } }),
    );
    const outputChunks = [
      "process.stdout.write('x'.repeat(40));",
      "setTimeout(() => process.stdout.write('discarded-prefix'), 10);",
      "setTimeout(() => process.stdout.write('> docsfab@1.2.3 test'), 20);",
    ].join(" ");
    const result = await executeCommand({
      file: process.execPath,
      args: ["-e", `${outputChunks} setTimeout(() => process.exit(1), 30);`, "npm", "run", "check"],
      cwd: root.root,
      environment: { PATH: process.env.PATH },
      diagnosticProfile: "runtime-check",
    });

    expect(result.exitCode).toBe(1);
    expect(result.diagnostic).toEqual({ termination: "exit" });
  });

  it("does not infer the diagnostic profile from incidental subprocess arguments", async () => {
    const root = await testRoot();
    const result = await executeCommand({
      file: process.execPath,
      args: ["-e", "process.exit(1)", "npm", "run", "check"],
      cwd: root.root,
      environment: { PATH: process.env.PATH },
    });

    expect(result.exitCode).toBe(1);
    expect(result.diagnostic).toBeUndefined();
    expect(result.output).toBe("");
  });

  it("fails before repository commands when deny-network isolation is unavailable", async () => {
    const root = await testRoot();
    const fake = fakeExecutor();

    await expect(
      runAcceptanceCli(
        args(root),
        dependencies(fake.execute, {
          isolateOffline: async () => {
            throw new Error("isolation unavailable");
          },
        }),
      ),
    ).rejects.toThrow("isolation unavailable");
    expect(fake.calls).toEqual([]);
  });

  it("completes offline without executing live commands or streaming subprocess output", async () => {
    const root = await testRoot();
    const fake = fakeExecutor();
    const result = await runAcceptanceCli(
      args(root),
      dependencies(fake.execute, {
        environment: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          MODEL_API_KEY: "ambient-model-secret",
          JUDGE_API_KEY: "ambient-judge-secret",
          JUDGE_ENABLED: "true",
          GITHUB_TOKEN: "ambient-scm-secret",
        },
      }),
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as { passed: boolean };

    expect(result.exitCode).toBe(0);
    expect(manifest.passed).toBe(true);
    expect(fake.calls.every((call) => call.stream === false)).toBe(true);
    expect(fake.calls.some((call) => call.args.includes("--live"))).toBe(false);
    expect(
      fake.calls.some((call) => call.args.includes("run") && call.args.includes("readiness")),
    ).toBe(false);
    const localCalls = fake.calls.filter((call) => call.file === "git" || call.file === "tar");
    expect(localCalls.length).toBeGreaterThan(0);
    expect(
      localCalls.every(
        (call) =>
          call.environment.MODEL_API_KEY === undefined &&
          call.environment.JUDGE_API_KEY === undefined &&
          call.environment.GITHUB_TOKEN === undefined,
      ),
    ).toBe(true);
  });

  it.each([
    ["setup", { failArchive: true }, {}],
    ["phase", { failBuild: true }, {}],
    ["source-integrity", { changeSource: true }, {}],
    ["source-integrity-head", { changeSourceHead: true }, {}],
    ["source-integrity-tree", { changeSourceTree: true }, {}],
    ["source-integrity-object-format", { changeSourceObjectFormat: true }, {}],
    ["evidence", { malformedEvidence: true }, { live: true }],
  ] as const)("publishes a failing manifest for %s failure", async (_name, fakeOptions, mode) => {
    const root = await testRoot();
    const fake = fakeExecutor(fakeOptions);
    const live = "live" in mode && mode.live === true;
    const environment = live
      ? { ...validModelEnvironment, DOCSFAB_ACCEPTANCE_LIVE: "true" }
      : { PATH: process.env.PATH, HOME: process.env.HOME };
    const result = await runAcceptanceCli(
      args(root, live),
      dependencies(fake.execute, {
        environment,
        loadConfiguration: () => configuration(),
      }),
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      passed: boolean;
      phases: Array<{ id: string; status: string }>;
    };

    expect(result.exitCode).toBe(1);
    expect(manifest.passed).toBe(false);
    expect(manifest.phases.some((phase) => phase.status === "failed")).toBe(true);
  });

  it("publishes cleanup failure after retrying removal", async () => {
    const root = await testRoot();
    const fake = fakeExecutor();
    const result = await runAcceptanceCli(
      args(root),
      dependencies(fake.execute, {
        remove: async () => {
          throw new Error("cleanup denied");
        },
      }),
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      phases: Array<{ id: string; status: string }>;
    };
    expect(result.exitCode).toBe(1);
    expect(manifest.phases).toContainEqual(
      expect.objectContaining({
        id: "workspace-cleanup",
        status: "failed",
      }),
    );
  });

  it("creates unique non-overwriting invocation directories", async () => {
    const root = await testRoot();
    const firstFake = fakeExecutor();
    const first = await runAcceptanceCli(args(root), dependencies(firstFake.execute));
    const secondFake = fakeExecutor();
    const second = await runAcceptanceCli(
      args(root),
      dependencies(secondFake.execute, {
        randomId: () => "87654321-0000-0000-0000-000000000000",
      }),
    );

    expect(second.acceptanceId).not.toBe(first.acceptanceId);
    expect(second.manifestPath).not.toBe(first.manifestPath);
    expect(await readdir(root.evidenceRoot)).toHaveLength(2);
  });

  it.each([false, true])(
    "collects the minimized live manifest before returning failure=%s",
    async (failed) => {
      const root = await testRoot();
      const repository = join(root.root, "checkout");
      await mkdir(repository);
      const collect = join(repository, "ci-results", "live-model");
      const ciJobToken = "collect-ci-job-token-value";
      const fake = fakeExecutor(failed ? { selfDispositionNotAdvisory: true } : {});
      const logs: string[] = [];
      const result = await runAcceptanceCli(
        [...args(root, true), "--collect-dir", collect],
        dependencies(fake.execute, {
          repositoryRoot: repository,
          environment: {
            ...validModelEnvironment,
            DOCSFAB_ACCEPTANCE_LIVE: "true",
            CI_JOB_TOKEN: ciJobToken,
          },
          loadConfiguration: () => configuration(),
          log: (message) => logs.push(message),
        }),
      );

      expect(result.exitCode, await readFile(result.manifestPath, "utf8")).toBe(failed ? 1 : 0);
      expect(result.passed).toBe(!failed);
      expect(result.collectedManifestPath).toBe(
        join(collect, result.acceptanceId, "manifest.json"),
      );
      const privateBytes = await readFile(result.manifestPath);
      const collectedBytes = await readFile(result.collectedManifestPath!);
      expect(collectedBytes.equals(privateBytes)).toBe(true);
      // Only the minimized manifest is collectable; raw run records stay private.
      expect(await readdir(collect)).toEqual([result.acceptanceId]);
      expect(await readdir(join(collect, result.acceptanceId))).toEqual(["manifest.json"]);
      expect(await readdir(join(root.stateRoot, result.acceptanceId))).toHaveLength(2);
      const collected = collectedBytes.toString("utf8");
      expect(JSON.parse(collected)).toMatchObject({ schemaVersion: 1, passed: !failed });
      expect(collected).not.toContain("securityScan");
      expect(collected).not.toContain(root.stateRoot);
      expect(collected).not.toContain(root.evidenceRoot);
      expect(collected).not.toContain(validModelEnvironment.MODEL_API_KEY);
      expect(collected).not.toContain(ciJobToken);
      expect(logs).toContain(`Collectable manifest: ${result.collectedManifestPath}`);
    },
  );

  it("keeps private roots outside the checkout when a collect directory is named", async () => {
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const fake = fakeExecutor();
    const collect = ["--collect-dir", join(repository, "ci-results")];
    await expect(
      runAcceptanceCli(
        ["--state-dir", join(repository, "state"), "--evidence-dir", root.evidenceRoot, ...collect],
        dependencies(fake.execute, { repositoryRoot: repository }),
      ),
    ).rejects.toThrow("--state-dir must be outside the source repository.");
    await expect(
      runAcceptanceCli(
        ["--state-dir", root.stateRoot, "--evidence-dir", join(repository, "evidence"), ...collect],
        dependencies(fake.execute, { repositoryRoot: repository }),
      ),
    ).rejects.toThrow("--evidence-dir must be outside the source repository.");
    for (const overlapping of [join(root.stateRoot, "collect"), root.root]) {
      await expect(
        runAcceptanceCli(
          [...args(root), "--collect-dir", overlapping],
          dependencies(fake.execute, { repositoryRoot: repository }),
        ),
      ).rejects.toThrow("--collect-dir must be disjoint from the private");
    }
    expect(
      fake.calls.every(
        (call) => call.file === "git" && call.args.join(" ") === "rev-parse --show-toplevel",
      ),
    ).toBe(true);
    expect(await readdir(repository)).toEqual([]);
  });

  it("refuses to collect a manifest that would carry a credential value", async () => {
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const fake = fakeExecutor();
    let error: unknown;
    try {
      // The manifest records the tested commit, so a credential equal to it
      // would leak through collection and must be refused.
      await runAcceptanceCli(
        [...args(root), "--collect-dir", join(repository, "ci-results")],
        dependencies(fake.execute, {
          repositoryRoot: repository,
          environment: { PATH: process.env.PATH, HOME: process.env.HOME, LEAKY_TOKEN: revision },
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain("value of LEAKY_TOKEN");
    expect((error as Error).message).not.toContain(revision);
    expect(await readdir(repository)).toEqual([]);
    expect(await readdir(root.evidenceRoot)).toHaveLength(1);
  });

  it("collects a failed check command's sanitized output beside the manifest", async () => {
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const collect = join(repository, "ci-results", "live-model");
    const jobToken = "check-output-ci-job-token-value";
    const shaped = `nvapi-${"q".repeat(32)}`;
    const colouredShape = `nvapi-\u001b[31m${"r".repeat(32)}\u001b[39m`;
    const fake = fakeExecutor({
      failCheckOutput: [
        "\u001b[31m FAIL \u001b[39m test/example.test.ts > reads the checkout",
        "Error: Test timed out in 5000ms.",
        `state written under ${root.stateRoot}/run`,
        `fixture header ${shaped} and ${colouredShape}`,
        `job token ${jobToken}`,
        ['    id: "author', 'ization:managed-state",'].join(""),
        "after the excerpt",
      ].join("\n"),
      failCheckDiagnostic: {
        termination: "signal",
        signal: "SIGTERM",
        script: "test",
        testFile: "test/../private-secret.test.ts",
      },
    });
    const logs: string[] = [];
    const result = await runAcceptanceCli(
      [...args(root), "--collect-dir", collect],
      dependencies(fake.execute, {
        repositoryRoot: repository,
        environment: { PATH: process.env.PATH, HOME: process.env.HOME, CI_JOB_TOKEN: jobToken },
        log: (message) => logs.push(message),
      }),
    );

    expect(result.exitCode).toBe(1);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      phases: Array<{
        id: string;
        status: string;
        reason?: string;
        diagnostic?: AcceptanceCommandDiagnostic;
      }>;
    };
    const checkPhase = manifest.phases.find((phase) => phase.id === "check");
    expect(checkPhase).toMatchObject({
      status: "failed",
      reason: "command exited nonzero",
    });
    expect(checkPhase?.diagnostic).toEqual({
      termination: "signal",
      signal: "SIGTERM",
      script: "test",
    });
    expect(JSON.stringify(checkPhase?.diagnostic)).not.toContain("private-secret");
    const invocation = join(collect, result.acceptanceId);
    expect((await readdir(invocation)).sort()).toEqual(["manifest.json", "phase-output.json"]);
    const collectedBytes = await readFile(join(invocation, "phase-output.json"));
    const privateBytes = await readFile(
      join(root.evidenceRoot, result.acceptanceId, "phase-output.json"),
    );
    expect(collectedBytes.equals(privateBytes)).toBe(true);
    const collected = JSON.parse(collectedBytes.toString("utf8")) as Record<string, unknown>;
    expect(collected).toMatchObject({
      schemaVersion: 1,
      acceptanceId: result.acceptanceId,
      testedCommit: revision,
      phase: "check",
      command: "npm run check",
      exitCode: 1,
    });
    const output = collected.output as string;
    expect(output).toContain(" FAIL  test/example.test.ts > reads the checkout");
    expect(output).toContain("Error: Test timed out in 5000ms.");
    expect(output).toContain("state written under [private root]/run");
    expect(output).toContain("job token [redacted CI_JOB_TOKEN]");
    // Clean as raw text but flagged once serialized: withheld instead of
    // blocking the whole collection.
    expect(output).toContain(`\n${ACCEPTANCE_WITHHELD_LINE}\nafter the excerpt`);
    expect(output).not.toContain("managed-state");
    expect(output).not.toContain(root.stateRoot);
    expect(output).not.toContain(jobToken);
    expect(output).not.toContain("q".repeat(32));
    expect(output).not.toContain("r".repeat(32));
    expect(output).not.toContain("\u001b");
    expect(logs).toContain(
      `Collectable failed phase output: ${join(invocation, "phase-output.json")}`,
    );
  });

  it("collects the offline export doctor's named readiness differences beside the manifest", async () => {
    // A seven-check missing-configuration readiness, refused and rendered by
    // the export doctor's own failure boundary.
    const readiness = {
      selectedUse: "local-review",
      status: "blocked",
      repositoryRevision: "c".repeat(40),
      checks: [
        ["installation", "ready"],
        ["configuration", "blocked"],
        ["repository", "ready"],
        ["provider", "ready"],
        ["gitlab", "blocked"],
        ["private-state", "blocked"],
        ["validation", "ready"],
      ].map(([area, status]) => ({ area, status })),
      diagnostics: [{ area: "configuration", code: "project-config-missing" }],
      validationCommand: "npm run check",
      autoModesReady: [],
      liveConnectivity: { requested: false, provider: "not-requested", gitlab: "not-requested" },
    } as unknown as DoctorReadinessResult;
    const refusal = await inspectAcceptanceExportDoctor(
      { cwd: "/export", expectedRevision: revision, expectedTree: sourceTree, live: false },
      { inspectReadiness: async () => readiness, readTree: async () => sourceTree },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    const written: string[] = [];
    reportOperatorFailure(refusal, { json: false, write: (line) => written.push(line) });
    const doctorOutput = `${written.join("\n")}\n`;
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const collect = join(repository, "ci-results", "live-model");
    const fake = fakeExecutor({ failDoctorOutput: doctorOutput });
    const result = await runAcceptanceCli(
      [...args(root), "--collect-dir", collect],
      dependencies(fake.execute, { repositoryRoot: repository }),
    );

    expect(result.exitCode).toBe(1);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      phases: Array<{ id: string; status: string }>;
    };
    expect(manifest.phases.find((phase) => phase.id === "offline-doctor")?.status).toBe("failed");
    const collected = JSON.parse(
      await readFile(join(collect, result.acceptanceId, "phase-output.json"), "utf8"),
    ) as { phase: string; exitCode: number; output: string };
    expect(collected).toMatchObject({ phase: "offline-doctor", exitCode: 1 });
    expect(collected.output).toBe(doctorOutput);
    expect(collected.output.split("\n").slice(0, 9)).toEqual([
      "Acceptance export doctor found an unexpected governed disposition.",
      "Differences from the expected readiness:",
      "- status: observed blocked, expected ready",
      "- configuration check: observed blocked, expected ready",
      "- gitlab check: observed blocked, expected absent",
      "- private-state check: observed blocked, expected absent",
      "- diagnostic codes: observed [project-config-missing], expected []",
      "- validation command: observed npm run check, expected none",
      "- auto modes ready: observed 0 [], expected 2 [dry-run, patch-only]",
    ]);
  });

  it("redacts the prepared secrets.env credential from a failed check's collected output", async () => {
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const collect = join(repository, "ci-results", "live-model");
    const configurationRoot = join(root.root, "config");
    const preparedKey = `prepared-live-key-${"k".repeat(24)}`;
    await prepareLiveModelCiConfig({ configurationRoot, modelApiKey: preparedKey });
    const snapshot = { ...process.env };
    // As in CI, the acceptance process receives no key: only the prepared
    // configuration root holds it, and the real loader reads it from there.
    for (const name of Object.keys(process.env)) {
      if (/^(?:MODEL|JUDGE)_|_API_KEY$|^DOCSFAB_ACTIVE_/u.test(name)) delete process.env[name];
    }
    process.env.DOCSFAB_CONFIG_ROOT = configurationRoot;
    process.env.DOCSFAB_ACCEPTANCE_LIVE = "true";
    let effectiveConfigurationEnvironment: NodeJS.ProcessEnv | undefined;
    try {
      const fake = fakeExecutor({ failCheckOutput: `a test printed ${preparedKey} and failed` });
      const result = await runAcceptanceCli(
        [
          ...args(root),
          "--live",
          "--approve-model-url",
          liveModelApproveUrl(),
          "--collect-dir",
          collect,
        ],
        dependencies(fake.execute, {
          repositoryRoot: repository,
          environment: process.env,
          loadConfiguration: (effectiveEnvironment) => {
            effectiveConfigurationEnvironment = effectiveEnvironment;
            return loadConfig(effectiveEnvironment);
          },
        }),
      );

      expect(result.exitCode).toBe(1);
      // Positive control: the credential was loaded from secrets.env privately;
      // gate validation and redaction succeed without exporting it to process.env.
      expect(process.env.MODEL_API_KEY).toBeUndefined();
      expect(effectiveConfigurationEnvironment?.MODEL_BASE_URL).toBe(liveModelApproveUrl());
      expect(effectiveConfigurationEnvironment?.MODEL_API_KEY).toBe(preparedKey);
      const collected = await readFile(
        join(collect, result.acceptanceId, "phase-output.json"),
        "utf8",
      );
      expect(collected).not.toContain(preparedKey);
      expect(collected).not.toContain("k".repeat(24));
      expect((JSON.parse(collected) as { output: string }).output).toMatch(
        /^a test printed \[(?:redacted [A-Z_]+|REDACTED)\] and failed$/u,
      );
    } finally {
      for (const name of Object.keys(process.env)) {
        if (!Object.hasOwn(snapshot, name)) delete process.env[name];
      }
      Object.assign(process.env, snapshot);
    }
  });

  it("runs the offline check without the stub profile or acceptance state directory", async () => {
    const root = await testRoot();
    const fake = fakeExecutor();
    await runAcceptanceCli(args(root), dependencies(fake.execute));
    const check = fake.calls.find(
      (call) => call.file === "npm" && call.args.join(" ") === "run check",
    );
    // An ambient MODEL_* value outranks a test fixture's configuration root, so
    // the suite runs without the stub profile, as ordinary CI test jobs do.
    const checkEnvironment = check!.environment;
    expect(
      Object.keys(checkEnvironment).filter(
        (name) =>
          name.startsWith("MODEL_") || name === "JUDGE_ENABLED" || name === "DOCSFAB_STATE_DIR",
      ),
    ).toEqual([]);
    // Everything else is the offline environment unchanged, as the build phase receives it.
    const build = fake.calls.find(
      (call) => call.file === "npm" && call.args.join(" ") === "run build",
    );
    const synthesized = new Set([
      ...Object.keys(build!.environment).filter((name) => name.startsWith("MODEL_")),
      "JUDGE_ENABLED",
      "DOCSFAB_STATE_DIR",
    ]);
    expect(checkEnvironment).toEqual(
      Object.fromEntries(
        Object.entries(build!.environment).filter(([name]) => !synthesized.has(name)),
      ),
    );
    expect(checkEnvironment.PI_OFFLINE).toBe("1");
    expect(checkEnvironment.HOME).toBeDefined();
    // Positive control: the phases that need the stub profile still receive it.
    const doctor = fake.calls.find((call) =>
      call.args.includes("dist/acceptance-export-doctor.js"),
    );
    expect(doctor?.environment).toMatchObject({
      MODEL_API_KEY: "offline-placeholder-not-a-credential",
      JUDGE_ENABLED: "false",
      DOCSFAB_STATE_DIR: expect.stringContaining(root.stateRoot),
    });
  });

  it("runs the offline check on CI test budgets when the harness runs under CI", async () => {
    const root = await testRoot();
    const check = (calls: ReturnType<typeof fakeExecutor>["calls"]) =>
      calls.find((call) => call.file === "npm" && call.args.join(" ") === "run check")!;
    const ci = fakeExecutor();
    await runAcceptanceCli(
      args(root),
      dependencies(ci.execute, {
        environment: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "true" },
      }),
    );
    expect(check(ci.calls).environment.CI).toBe("true");
    expect(vitestDefaultTimeouts(check(ci.calls).environment)).toEqual({
      testTimeout: limit(TEST_TIMEOUT_LIMITS.ciTest).value,
      hookTimeout: limit(TEST_TIMEOUT_LIMITS.ciHook).value,
    });

    // Positive control: a developer run outside CI keeps the local budgets.
    const local = fakeExecutor();
    await runAcceptanceCli(
      args(root),
      dependencies(local.execute, {
        randomId: () => "87654321-0000-0000-0000-000000000000",
      }),
    );
    expect(check(local.calls).environment.CI).toBeUndefined();
    expect(vitestDefaultTimeouts(check(local.calls).environment).testTimeout).toBe(
      limit(TEST_TIMEOUT_LIMITS.localTest).value,
    );
  });

  it("names each check limitation and the measured owner of / in the output and manifest", async () => {
    const root = await testRoot();
    const fake = fakeExecutor();
    const logs: string[] = [];
    const result = await runAcceptanceCli(
      args(root),
      dependencies(withoutDenyNetworkPrefix(fake.execute), {
        isolateOffline: async () => ({
          commandPrefix: ["deny-network", "--"],
          hostRootOwner: { outside: 0, inside: 65534 },
        }),
        log: (message) => logs.push(message),
      }),
    );
    const check = fake.calls.find(
      (call) => call.file === "npm" && call.args.join(" ") === "run check",
    )!;

    expect(result.passed).toBe(true);
    expect(check.environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]).toBe(
      "host-uid-view,registry-metadata",
    );
    expect(logs).toContain(
      "Acceptance check: / is owned by uid 65534 inside the offline sandbox and uid 0 outside.",
    );
    for (const limitation of ACCEPTANCE_CHECK_LIMITATIONS) {
      expect(logs).toContain(
        `Acceptance check limitation: ${limitation.file} not run (${limitation.reason})`,
      );
    }
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      checkLimitations: unknown;
    };
    expect(manifest.checkLimitations).toEqual({
      networkDenied: true,
      hostRootOwner: { outside: 0, inside: 65534 },
      excluded: [...ACCEPTANCE_CHECK_LIMITATIONS],
    });
  });

  it("keeps the ownership-bound files when the sandbox shows the host owner of /", async () => {
    const root = await testRoot();
    const fake = fakeExecutor();
    const logs: string[] = [];
    const result = await runAcceptanceCli(
      args(root),
      dependencies(withoutDenyNetworkPrefix(fake.execute), {
        isolateOffline: async () => ({
          commandPrefix: ["deny-network", "--"],
          hostRootOwner: { outside: 0, inside: 0 },
        }),
        log: (message) => logs.push(message),
      }),
    );
    const check = fake.calls.find(
      (call) => call.file === "npm" && call.args.join(" ") === "run check",
    )!;
    const registryBound = ACCEPTANCE_CHECK_LIMITATIONS.filter(
      (limitation) => limitation.cause === "registry-metadata",
    );

    expect(check.environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]).toBe("registry-metadata");
    expect(logs).toContain(
      "Acceptance check: / is owned by uid 0 inside the offline sandbox and uid 0 outside.",
    );
    expect(logs.filter((line) => line.startsWith("Acceptance check limitation:"))).toEqual(
      registryBound.map(
        (limitation) =>
          `Acceptance check limitation: ${limitation.file} not run (${limitation.reason})`,
      ),
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      checkLimitations: unknown;
    };
    expect(manifest.checkLimitations).toEqual({
      networkDenied: true,
      hostRootOwner: { outside: 0, inside: 0 },
      excluded: registryBound,
    });
  });

  it("never lets the caller's environment choose check limitations", async () => {
    const root = await testRoot();
    const injected = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      [ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]: "host-uid-view,registry-metadata",
    };
    const unsandboxed = fakeExecutor();
    await runAcceptanceCli(
      args(root),
      dependencies(unsandboxed.execute, { environment: injected }),
    );
    const measured = fakeExecutor();
    await runAcceptanceCli(
      args(root),
      dependencies(withoutDenyNetworkPrefix(measured.execute), {
        environment: injected,
        randomId: () => "87654321-0000-0000-0000-000000000000",
        isolateOffline: async () => ({
          commandPrefix: ["deny-network", "--"],
          hostRootOwner: { outside: 0, inside: 0 },
        }),
      }),
    );
    const check = (calls: ReturnType<typeof fakeExecutor>["calls"]) =>
      calls.find((call) => call.file === "npm" && call.args.join(" ") === "run check")!;

    expect(check(unsandboxed.calls).environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]).toBe(
      undefined,
    );
    expect(check(measured.calls).environment[ACCEPTANCE_CHECK_LIMITATIONS_VARIABLE]).toBe(
      "registry-metadata",
    );
  });

  it("measures the owner of / inside the sandbox and reports an unreadable probe as unmeasured", async () => {
    const outside = (await stat("/")).uid;
    const probes: Array<{ file: string; args: string[] }> = [];
    const answering =
      (answer: () => Promise<{ exitCode: number; stdout: string }>): AcceptanceCommandExecutor =>
      async (command) => {
        probes.push({ file: command.file, args: command.args });
        return answer();
      };

    expect(
      await probeHostRootOwner(
        ["deny-network", "--"],
        answering(async () => ({ exitCode: 0, stdout: "65534\n" })),
      ),
    ).toEqual({ outside, inside: 65534 });
    expect(probes[0]?.file).toBe("deny-network");
    expect(probes[0]?.args.slice(0, 3)).toEqual(["--", process.execPath, "-e"]);
    for (const answer of [
      async () => ({ exitCode: 1, stdout: "0" }),
      async () => ({ exitCode: 0, stdout: "not a uid" }),
      async () => {
        throw new Error("probe could not start");
      },
    ]) {
      expect(await probeHostRootOwner(["deny-network", "--"], answering(answer))).toEqual({
        outside,
        inside: null,
      });
    }
    // Positive control: the real probe script reads the owner of / through a
    // prefix that adds no namespace.
    expect(await probeHostRootOwner(["/usr/bin/env", "--"])).toEqual({ outside, inside: outside });
  });

  it.runIf(process.platform === "darwin")(
    "measures the host owner of / through the real macOS offline sandbox",
    async () => {
      const isolation = await offlineIsolation();

      expect(isolation.commandPrefix[0]).toBe("/usr/bin/sandbox-exec");
      expect(isolation.hostRootOwner).toEqual({ outside: 0, inside: 0 });
    },
  );

  it.runIf(process.platform === "linux")(
    "measures the owner of / through the real Linux offline sandbox",
    async () => {
      const isolation = await offlineIsolation();
      const owner = isolation.hostRootOwner!;

      expect(owner.inside, JSON.stringify(owner)).not.toBeNull();
      // An unprivileged process's bwrap creates a user namespace that maps only
      // its own uid, so a host-root-owned / cannot show as uid 0 inside it.
      const unprivilegedBwrap =
        isolation.commandPrefix[0] === "/usr/bin/bwrap" &&
        process.getuid?.() !== 0 &&
        ((await stat("/usr/bin/bwrap")).mode & 0o4000) === 0;
      if (unprivilegedBwrap && owner.outside === 0) {
        expect(owner.inside, JSON.stringify(owner)).not.toBe(0);
      }
    },
  );

  it("keeps a failed networked phase's provider output out of collected evidence", async () => {
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const collect = join(repository, "ci-results", "live-model");
    const fake = fakeExecutor({ failLiveSelf: true });
    const logs: string[] = [];
    const result = await runAcceptanceCli(
      [...args(root, true), "--collect-dir", collect],
      dependencies(fake.execute, {
        repositoryRoot: repository,
        environment: { ...validModelEnvironment, DOCSFAB_ACCEPTANCE_LIVE: "true" },
        loadConfiguration: () => configuration(),
        log: (message) => logs.push(message),
      }),
    );

    expect(result.exitCode).toBe(1);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      phases: Array<{ id: string; status: string }>;
    };
    expect(
      manifest.phases.find((phase) => phase.id === "live-self-readiness")?.status,
      JSON.stringify(manifest.phases),
    ).toBe("failed");
    // The raw output is never kept: only a summary that names no code, because
    // the command printed no structured failure report.
    const invocation = join(collect, result.acceptanceId);
    expect((await readdir(invocation)).sort()).toEqual([
      "manifest.json",
      "networked-phase-failure.json",
    ]);
    expect((await readdir(join(root.evidenceRoot, result.acceptanceId))).sort()).toEqual([
      "manifest.json",
      "networked-phase-failure.json",
    ]);
    const collected = await readFile(join(invocation, "networked-phase-failure.json"), "utf8");
    expect(JSON.parse(collected)).toEqual({
      schemaVersion: 1,
      acceptanceId: result.acceptanceId,
      testedCommit: revision,
      phase: "live-self-readiness",
      exitCode: 1,
      report: "none",
    });
    expect(collected).not.toContain("raw provider detail");
    expect(logs).toContain(
      "Networked phase failure: live-self-readiness exited 1 without a structured failure report.",
    );
    expect(logs.some((message) => message.includes("phase output"))).toBe(false);
  });

  it("collects a failed live doctor's JSON failure envelope as a summary that names its code", async () => {
    // The live doctor's own failure boundary, asked for JSON as the plan asks it.
    const written: string[] = [];
    const envelope = reportOperatorFailure(
      Object.assign(new Error("The policy provider refused the request."), {
        code: "invalid-model-profile-configuration",
      }),
      { json: true, write: (line) => written.push(line) },
    );
    // Positive control: the report names a next action and a docs reference.
    expect(envelope.nextAction).toEqual(expect.any(String));
    expect(envelope.docsAnchor).toEqual(expect.any(String));
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const collect = join(repository, "ci-results", "live-model");
    const fake = fakeExecutor({
      failNetworked: {
        phase: "live-doctor",
        stdout: "raw provider detail must stay captured\n",
        stderr: `progress before the report\n${written.join("\n")}\n`,
      },
    });
    const logs: string[] = [];
    const result = await runAcceptanceCli(
      [...args(root, true), "--collect-dir", collect],
      dependencies(fake.execute, {
        repositoryRoot: repository,
        environment: { ...validModelEnvironment, DOCSFAB_ACCEPTANCE_LIVE: "true" },
        loadConfiguration: () => configuration(),
        log: (message) => logs.push(message),
      }),
    );

    expect(result.exitCode).toBe(1);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      phases: Array<{ id: string; status: string; reason?: string }>;
    };
    // The manifest and the acceptance result are what they were without the summary.
    expect(manifest.phases.find((phase) => phase.id === "live-doctor")).toMatchObject({
      status: "failed",
      reason: "command exited nonzero",
    });
    expect(manifest.phases.find((phase) => phase.id === "live-self-readiness")?.status).toBe(
      "skipped",
    );
    const invocation = join(collect, result.acceptanceId);
    expect((await readdir(invocation)).sort()).toEqual([
      "manifest.json",
      "networked-phase-failure.json",
    ]);
    const collectedBytes = await readFile(join(invocation, "networked-phase-failure.json"));
    const privatePath = join(
      root.evidenceRoot,
      result.acceptanceId,
      "networked-phase-failure.json",
    );
    expect(collectedBytes.equals(await readFile(privatePath))).toBe(true);
    const collected = collectedBytes.toString("utf8");
    expect(JSON.parse(collected)).toEqual({
      schemaVersion: 1,
      acceptanceId: result.acceptanceId,
      testedCommit: revision,
      phase: "live-doctor",
      exitCode: 1,
      report: "operator-error",
      code: "invalid-model-profile-configuration",
      failure: {
        class: "operator-input",
        layer: "cli",
        code: "invalid-model-profile-configuration",
      },
      nextAction: envelope.nextAction,
      docsAnchor: envelope.docsAnchor,
    });
    for (const fragment of ["raw provider detail", "refused the request", "progress before"]) {
      expect(collected).not.toContain(fragment);
    }
    expect(logs).toContain(
      "Networked phase failure: live-doctor exited 1, code invalid-model-profile-configuration, failure class operator-input (layer cli).",
    );
    expect(logs).toContain(`Networked phase failure summary: ${privatePath}`);
    expect(logs).toContain(
      `Collectable networked phase failure summary: ${join(invocation, "networked-phase-failure.json")}`,
    );
  });

  it("prints the trace line the acceptance guide shows for a failed live doctor", async () => {
    // The code is one the live doctor throws, so the guide's example is a line a run prints.
    const { printed } = printedOperatorEnvelope("live-model-check-failed");
    const run = await liveAcceptance({ failNetworked: { phase: "live-doctor", stderr: printed } });

    const line =
      "Networked phase failure: live-doctor exited 1, code live-model-check-failed, failure class infrastructure (layer cli).";
    expect(run.logs).toContain(line);
    const guide = await readFile(
      new URL("../docs/prove-a-doc-change/mvp-acceptance.md", import.meta.url),
      "utf8",
    );
    expect(guide.split("\n")).toContain(line);
  });

  it("keeps a credential in a networked failure report out of the collected summary", async () => {
    const key = validModelEnvironment.MODEL_API_KEY;
    const shaped = `nvapi-${"s".repeat(32)}`;
    // A report that did not scrub itself, with a classified code that differs:
    // the harness trusts none of its text.
    const report = JSON.stringify(
      {
        schemaVersion: 1,
        kind: "docsfab-operator-error",
        code: "operator-error",
        message: `The provider refused ${key} and ${shaped}.`,
        nextAction: `Replace the key ${key}, then rerun the live doctor.`,
        docsAnchor: `docs/setup.md ${shaped}`,
        failure: { class: "auth", layer: "cli", code: "provider-credentials-missing" },
      },
      null,
      2,
    );
    // Positive control: the child's report carries the credential value and shape.
    expect(report).toContain(key);
    expect(report).toContain(shaped);
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const collect = join(repository, "ci-results", "live-model");
    const fake = fakeExecutor({
      failNetworked: { phase: "live-doctor", stdout: `${key} ${shaped}\n`, stderr: report },
    });
    const logs: string[] = [];
    const result = await runAcceptanceCli(
      [...args(root, true), "--collect-dir", collect],
      dependencies(fake.execute, {
        repositoryRoot: repository,
        environment: { ...validModelEnvironment, DOCSFAB_ACCEPTANCE_LIVE: "true" },
        loadConfiguration: () => configuration(),
        log: (message) => logs.push(message),
      }),
    );

    expect(result.exitCode).toBe(1);
    const collected = await readFile(
      join(collect, result.acceptanceId, "networked-phase-failure.json"),
      "utf8",
    );
    for (const fragment of [key, "s".repeat(32), "The provider refused"]) {
      expect(collected).not.toContain(fragment);
    }
    const summary = JSON.parse(collected) as Record<string, unknown>;
    expect(summary).toMatchObject({
      report: "operator-error",
      code: "operator-error",
      failure: { class: "auth", layer: "cli", code: "provider-credentials-missing" },
      nextAction: "Replace the key [redacted MODEL_API_KEY], then rerun the live doctor.",
    });
    expect(summary.docsAnchor).toEqual(expect.stringMatching(/^docs\/setup\.md /u));
    expect(Object.keys(summary)).not.toContain("message");
    expect(logs).toContain(
      "Networked phase failure: live-doctor exited 1, code operator-error, failure class auth (layer cli, code provider-credentials-missing).",
    );
    for (const line of logs) {
      expect(line).not.toContain(key);
      expect(line).not.toContain("s".repeat(32));
    }
  });

  it("collects a failed live readiness run's code from the run failure in its JSON run result", async () => {
    const runResult = JSON.stringify(
      {
        schemaVersion: 1,
        kind: "docsfab-run-result",
        execution: { runId: "run-1", workflow: "readiness", status: "failed", exitCode: 1 },
        failures: [
          { scope: "run", class: "infrastructure", layer: "inference", code: "provider-network" },
          {
            scope: "step",
            stepId: "assess-readiness",
            class: "infrastructure",
            layer: "inference",
            code: "provider-network",
          },
        ],
        nextSteps: ["docsfab runs show run-1"],
      },
      null,
      2,
    );
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const collect = join(repository, "ci-results", "live-model");
    const fake = fakeExecutor({
      failNetworked: {
        phase: "live-self-readiness",
        stdout: `${runResult}\n`,
        stderr: "PREFLIGHT\n  raw provider detail must stay captured\n",
      },
    });
    const logs: string[] = [];
    const result = await runAcceptanceCli(
      [...args(root, true), "--collect-dir", collect],
      dependencies(fake.execute, {
        repositoryRoot: repository,
        environment: { ...validModelEnvironment, DOCSFAB_ACCEPTANCE_LIVE: "true" },
        loadConfiguration: () => configuration(),
        log: (message) => logs.push(message),
      }),
    );

    expect(result.exitCode).toBe(1);
    const collected = await readFile(
      join(collect, result.acceptanceId, "networked-phase-failure.json"),
      "utf8",
    );
    expect(JSON.parse(collected)).toEqual({
      schemaVersion: 1,
      acceptanceId: result.acceptanceId,
      testedCommit: revision,
      phase: "live-self-readiness",
      exitCode: 1,
      report: "run-result",
      code: "provider-network",
      failure: { class: "infrastructure", layer: "inference", code: "provider-network" },
    });
    expect(collected).not.toContain("raw provider detail");
    expect(logs).toContain(
      "Networked phase failure: live-self-readiness exited 1, code provider-network, failure class infrastructure (layer inference).",
    );
  });

  it("collects a failed live fixture readiness run as that phase's summary", async () => {
    const run = await liveAcceptance({
      failNetworked: {
        phase: "live-fixture-readiness",
        stdout: `${failedRunResultJson("provider-network")}\n`,
        stderr: "PREFLIGHT\n  raw provider detail must stay captured\n",
      },
    });

    expect(run.result.exitCode).toBe(1);
    // The fixture's own readiness run failed, so the self run never started.
    expect(run.statuses).toMatchObject({
      "live-doctor": "passed",
      "live-fixture-readiness": "failed",
      "live-self-readiness": "skipped",
    });
    const summary = await run.collectedSummary();
    expect(summary.value).toEqual({
      schemaVersion: 1,
      acceptanceId: run.result.acceptanceId,
      testedCommit: revision,
      phase: "live-fixture-readiness",
      exitCode: 1,
      report: "run-result",
      code: "provider-network",
      failure: { class: "infrastructure", layer: "inference", code: "provider-network" },
    });
    expect(summary.text).not.toContain("raw provider detail");
    expect(run.logs).toContain(
      "Networked phase failure: live-fixture-readiness exited 1, code provider-network, failure class infrastructure (layer inference).",
    );
  });

  it("collects a failed judge smoke with no JSON report as a summary that names no code", async () => {
    // A structural or judge-error failure exits 1 and prints no JSON.
    const run = await liveAcceptance(
      { failNetworked: { phase: "judge-smoke", stderr: "" } },
      { judge: true },
    );

    expect(run.result.exitCode).toBe(1);
    // The record-binding pre-check passed, so the judge command ran and failed.
    expect(run.calls.some((call) => call.args[0] === "dist/acceptance-judge.js")).toBe(true);
    expect(run.statuses).toMatchObject({
      "live-self-readiness": "passed",
      "judge-smoke": "failed",
    });
    expect((await run.collectedSummary()).value).toEqual({
      schemaVersion: 1,
      acceptanceId: run.result.acceptanceId,
      testedCommit: revision,
      phase: "judge-smoke",
      exitCode: 1,
      report: "none",
    });
    expect(run.logs).toContain(
      "Networked phase failure: judge-smoke exited 1 without a structured failure report.",
    );
  });

  it("collects a failed judge smoke's JSON failure envelope as a summary that names its code", async () => {
    const { printed, envelope } = printedOperatorEnvelope("invalid-model-profile-configuration");
    // Positive control: the report names a next action and a docs reference.
    expect(envelope.nextAction).toEqual(expect.any(String));
    expect(envelope.docsAnchor).toEqual(expect.any(String));
    const run = await liveAcceptance(
      {
        failNetworked: {
          phase: "judge-smoke",
          stdout: "raw provider detail must stay captured\n",
          stderr: printed,
        },
      },
      { judge: true },
    );

    expect(run.result.exitCode).toBe(1);
    expect(run.statuses).toMatchObject({ "judge-smoke": "failed" });
    const summary = await run.collectedSummary();
    expect(summary.value).toEqual({
      schemaVersion: 1,
      acceptanceId: run.result.acceptanceId,
      testedCommit: revision,
      phase: "judge-smoke",
      exitCode: 1,
      report: "operator-error",
      code: "invalid-model-profile-configuration",
      failure: {
        class: "operator-input",
        layer: "cli",
        code: "invalid-model-profile-configuration",
      },
      nextAction: envelope.nextAction,
      docsAnchor: envelope.docsAnchor,
    });
    expect(summary.text).not.toContain("raw provider detail");
    expect(run.logs).toContain(
      "Networked phase failure: judge-smoke exited 1, code invalid-model-profile-configuration, failure class operator-input (layer cli).",
    );
  });

  it.each<[string, FakeOptions, string, number]>([
    [
      "the fixture's git commit",
      {
        failFixtureCommit: { exitCode: 128, stderr: "fatal: unable to auto-detect the email\n" },
      },
      "live-fixture-readiness",
      128,
    ],
    [
      "the live doctor",
      { failNetworked: { phase: "live-doctor", exitCode: 2, stderr: "no report\n" } },
      "live-doctor",
      2,
    ],
  ])("keeps the exit status %s exited with", async (_name, fakeOptions, phase, exitCode) => {
    const run = await liveAcceptance(fakeOptions);

    expect(run.result.exitCode).toBe(1);
    const summary = await run.collectedSummary();
    expect(summary.value).toEqual({
      schemaVersion: 1,
      acceptanceId: run.result.acceptanceId,
      testedCommit: revision,
      phase,
      exitCode,
      report: "none",
    });
    expect(summary.text).not.toContain("fatal");
    expect(run.logs).toContain(
      `Networked phase failure: ${phase} exited ${String(exitCode)} without a structured failure report.`,
    );
  });

  it("writes no summary or trace line when the judge's record-binding pre-check refuses", async () => {
    // The fixture's record names another revision, so the records are not the exact set.
    const run = await liveAcceptance({ wrongFixtureRecordRevision: true }, { judge: true });

    expect(run.result.exitCode).toBe(1);
    expect(run.statuses).toMatchObject({
      "live-self-readiness": "passed",
      "judge-smoke": "failed",
    });
    // The pre-check refused before the judge command started.
    expect(run.calls.some((call) => call.args[0] === "dist/acceptance-judge.js")).toBe(false);
    await run.expectNoSummary();
  });

  it.each<[string, { exitCode: number; stdout: string }]>([
    // Each answer breaks one of the two things the harness requires of the read.
    [
      "exits nonzero while printing a commit identity",
      { exitCode: 128, stdout: `${fixtureRevision}\n` },
    ],
    ["prints no commit identity", { exitCode: 0, stdout: "not-a-commit\n" }],
  ])(
    "writes no summary or trace line when the read of the fixture commit's revision %s",
    async (_name, answer) => {
      const run = await liveAcceptance({ failFixtureRevisionRead: answer });

      expect(run.result.exitCode).toBe(1);
      expect(run.statuses).toMatchObject({
        "live-fixture-readiness": "failed",
        "live-self-readiness": "skipped",
      });
      const inFixture = run.calls.filter((call) => call.cwd.endsWith("/fixture"));
      // The fixture commit and the revision read both ran; the readiness run did not.
      expect(inFixture.some((call) => call.args[0] === "commit")).toBe(true);
      expect(inFixture.some((call) => call.args.join(" ") === "rev-parse HEAD")).toBe(true);
      expect(
        run.calls.some((call) => call.args.includes("run") && call.args.includes("HEAD")),
      ).toBe(false);
      await run.expectNoSummary();
    },
  );

  it("reports a networked command that cannot be started as the setup phase, with no summary", async () => {
    const run = await liveAcceptance({ failNetworkedSpawn: "live-doctor" });

    expect(run.result.exitCode).toBe(1);
    expect(run.statuses.setup).toBe("failed");
    await run.expectNoSummary();
  });

  it("reports a networked failure summary it cannot keep or collect and keeps the acceptance result", async () => {
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const collect = join(repository, "ci-results", "live-model");
    const acceptanceId = "acceptance-2026-08-03T12-00-00-000Z-aaaaaaaaaaaa-12345678";
    // An earlier collection already holds the leaf, so the exclusive write is refused.
    await mkdir(join(collect, acceptanceId), { recursive: true, mode: 0o700 });
    await writeFile(join(collect, acceptanceId, "networked-phase-failure.json"), "{}\n", {
      mode: 0o600,
    });
    const fake = fakeExecutor({ failNetworked: { phase: "live-doctor", stderr: "no report\n" } });
    const logs: string[] = [];
    const writeEvidence: AcceptanceCliDependencies["writeEvidence"] = async (
      directory,
      file,
      value,
    ) => {
      if (file === "networked-phase-failure.json") throw new Error("evidence volume is full");
      await writeAcceptanceJsonExclusive(directory, file, value);
    };
    const result = await runAcceptanceCli(
      [...args(root, true), "--collect-dir", collect],
      dependencies(fake.execute, {
        repositoryRoot: repository,
        environment: { ...validModelEnvironment, DOCSFAB_ACCEPTANCE_LIVE: "true" },
        loadConfiguration: () => configuration(),
        writeEvidence,
        log: (message) => logs.push(message),
      }),
    );

    expect(result.acceptanceId).toBe(acceptanceId);
    expect(result.exitCode).toBe(1);
    expect(result.collectedManifestPath).toBe(join(collect, acceptanceId, "manifest.json"));
    expect(logs).toContain(
      "Networked phase failure: live-doctor exited 1 without a structured failure report.",
    );
    expect(logs).toContain("Networked phase failure summary was not kept: evidence volume is full");
    expect(
      logs.some((message) =>
        message.startsWith("Networked phase failure summary was not collected: "),
      ),
    ).toBe(true);
    expect(
      await readFile(join(collect, acceptanceId, "networked-phase-failure.json"), "utf8"),
    ).toBe("{}\n");
  });

  it("reports failed phase output it cannot keep or collect and keeps the acceptance result", async () => {
    const root = await testRoot();
    const repository = join(root.root, "checkout");
    await mkdir(repository);
    const collect = join(repository, "ci-results", "live-model");
    const acceptanceId = "acceptance-2026-08-03T12-00-00-000Z-aaaaaaaaaaaa-12345678";
    // An earlier collection already holds the leaf, so the exclusive write is refused.
    await mkdir(join(collect, acceptanceId), { recursive: true, mode: 0o700 });
    await writeFile(join(collect, acceptanceId, "phase-output.json"), "{}\n", { mode: 0o600 });
    const fake = fakeExecutor({ failCheckOutput: "FAIL test/example.test.ts" });
    const logs: string[] = [];
    const writeEvidence: AcceptanceCliDependencies["writeEvidence"] = async (
      directory,
      file,
      value,
    ) => {
      if (file === "phase-output.json") throw new Error("evidence volume is full");
      await writeAcceptanceJsonExclusive(directory, file, value);
    };
    const result = await runAcceptanceCli(
      [...args(root), "--collect-dir", collect],
      dependencies(fake.execute, {
        repositoryRoot: repository,
        writeEvidence,
        log: (message) => logs.push(message),
      }),
    );

    expect(result.acceptanceId).toBe(acceptanceId);
    expect(result.exitCode).toBe(1);
    expect(result.collectedManifestPath).toBe(join(collect, acceptanceId, "manifest.json"));
    expect(logs).toContain("Failed phase output was not kept: evidence volume is full");
    expect(
      logs.some((message) => message.startsWith("Failed phase output was not collected: ")),
    ).toBe(true);
    expect(await readFile(join(collect, acceptanceId, "phase-output.json"), "utf8")).toBe("{}\n");
  });

  it("keeps stderr with stdout in a command's combined output", async () => {
    const result = await executeCommand({
      file: process.execPath,
      args: [
        "-e",
        "process.stdout.write('stdout-line\\n'); process.stderr.write('stderr-line\\n'); process.exitCode = 3;",
      ],
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH },
    });

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("stdout-line\n");
    // Standard error alone too, where a networked command prints its failure envelope.
    expect(result.stderr).toBe("stderr-line\n");
    expect(result.output).toContain("stdout-line\n");
    expect(result.output).toContain("stderr-line\n");
  });

  it("requires exactly the fixture and revision-bound self records for live acceptance", async () => {
    const root = await testRoot();
    const environment = {
      ...validModelEnvironment,
      ...judgeEnvironment(),
      JUDGE_ENABLED: "true",
      DOCSFAB_ACCEPTANCE_LIVE: "true",
      UNRELATED_TOKEN: "must-not-cross-boundary",
      GITHUB_TOKEN: "must-not-cross-local-boundary",
    };
    const missing = fakeExecutor({ omitLiveRecords: true });
    const failed = await runAcceptanceCli(
      args(root, true),
      dependencies(missing.execute, {
        environment,
        loadConfiguration: () => configuration(),
      }),
    );
    expect(failed.exitCode).toBe(1);

    const wrongDispositionRoot = await testRoot();
    const wrongDisposition = fakeExecutor({ selfDispositionNotAdvisory: true });
    const wrongDispositionResult = await runAcceptanceCli(
      args(wrongDispositionRoot, true),
      dependencies(wrongDisposition.execute, {
        environment,
        loadConfiguration: () => configuration(),
      }),
    );
    expect(wrongDispositionResult.exitCode).toBe(1);

    const wrongFixtureRoot = await testRoot();
    const wrongFixture = fakeExecutor({ wrongFixtureRecordRevision: true });
    const wrongFixtureResult = await runAcceptanceCli(
      args(wrongFixtureRoot, true),
      dependencies(wrongFixture.execute, {
        environment,
        loadConfiguration: () => configuration(),
      }),
    );
    expect(wrongFixtureResult.exitCode).toBe(1);

    const completeRoot = await testRoot();
    const complete = fakeExecutor();
    const passed = await runAcceptanceCli(
      args(completeRoot, true),
      dependencies(complete.execute, {
        environment,
        loadConfiguration: () => configuration(),
      }),
    );
    expect(passed.exitCode, await readFile(passed.manifestPath, "utf8")).toBe(0);
    const liveCall = complete.calls.find((call) => call.args.includes("--live"));
    expect(liveCall?.environment.UNRELATED_TOKEN).toBeUndefined();
    expect(liveCall?.environment.MODEL_API_KEY).toBe(validModelEnvironment.MODEL_API_KEY);
    const policyCalls = complete.calls.filter(
      (call) =>
        call.file === "node" &&
        (call.args.includes("--live") ||
          (call.args.includes("run") && call.args.includes("readiness"))),
    );
    expect(
      policyCalls.every(
        (call) =>
          call.environment.JUDGE_ENABLED === "false" &&
          call.environment.JUDGE_API_KEY === undefined &&
          call.environment.JUDGE_MODEL_ID === undefined,
      ),
    ).toBe(true);
    const localCalls = complete.calls.filter((call) => call.file === "git" || call.file === "tar");
    expect(
      localCalls.every(
        (call) =>
          call.environment.MODEL_API_KEY === undefined &&
          call.environment.JUDGE_API_KEY === undefined &&
          call.environment.GITHUB_TOKEN === undefined,
      ),
    ).toBe(true);
    const manifest = JSON.parse(await readFile(passed.manifestPath, "utf8")) as {
      selfScanAuthorization?: unknown;
      records: Array<{
        scanDisposition?: string;
        models: Array<{ profileSha256?: string }>;
      }>;
    };
    // No scanner-authorization ceremony is recorded anywhere in the manifest.
    expect(manifest.selfScanAuthorization).toBeUndefined();
    expect(manifest.records.every((record) => record.scanDisposition === "advisory")).toBe(true);
    expect(
      manifest.records.every(
        (record) =>
          record.models[0]?.profileSha256 === createModelEvidence(validModelConfig).profile!.sha256,
      ),
    ).toBe(true);
  });

  it.each([
    ["forged override authorization", { selfCarriesAuthorization: true }],
    ["non-advisory disposition", { selfDispositionNotAdvisory: true }],
    ["mismatched model profile", { mismatchedProfile: true }],
  ])("rejects forged self scanner evidence with %s", async (_name, fakeOptions) => {
    const root = await testRoot();
    const fake = fakeExecutor(fakeOptions);
    const result = await runAcceptanceCli(
      args(root, true),
      dependencies(fake.execute, {
        environment: {
          ...validModelEnvironment,
          DOCSFAB_ACCEPTANCE_LIVE: "true",
        },
        loadConfiguration: () => configuration(),
      }),
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      passed: boolean;
      phases: Array<{ id: string; status: string }>;
    };

    expect(result.exitCode).toBe(1);
    expect(manifest.passed).toBe(false);
    expect(manifest.phases).toContainEqual(
      expect.objectContaining({
        id: "evidence",
        status: "failed",
      }),
    );
  });

  it("accepts judge evidence only when independently gated and bound", async () => {
    const environment = {
      ...validModelEnvironment,
      ...judgeEnvironment(),
      JUDGE_ENABLED: "true",
      DOCSFAB_ACCEPTANCE_LIVE: "true",
      DOCSFAB_ACCEPTANCE_JUDGE: "true",
    };
    const wrongRoot = await testRoot();
    const wrong = fakeExecutor({ bindJudge: false });
    const failed = await runAcceptanceCli(
      args(wrongRoot, true, true),
      dependencies(wrong.execute, {
        environment,
        loadConfiguration: () => configuration(true),
      }),
    );
    expect(failed.exitCode).toBe(1);

    const forgedRoot = await testRoot();
    const forged = fakeExecutor({ selfCarriesAuthorization: true });
    const blockedBeforeJudge = await runAcceptanceCli(
      args(forgedRoot, true, true),
      dependencies(forged.execute, {
        environment,
        loadConfiguration: () => configuration(true),
      }),
    );
    expect(blockedBeforeJudge.exitCode).toBe(1);
    expect(
      forged.calls.some(
        (call) => call.file === "node" && call.args[0] === "dist/acceptance-judge.js",
      ),
    ).toBe(false);

    const validRoot = await testRoot();
    const valid = fakeExecutor({ bindJudge: true });
    const passed = await runAcceptanceCli(
      args(validRoot, true, true),
      dependencies(valid.execute, {
        environment,
        loadConfiguration: () => configuration(true),
      }),
    );
    expect(passed.exitCode, await readFile(passed.manifestPath, "utf8")).toBe(0);
    const policyCalls = valid.calls.filter(
      (call) =>
        call.file === "node" &&
        (call.args.includes("--live") ||
          (call.args.includes("run") && call.args.includes("readiness"))),
    );
    expect(
      policyCalls.every(
        (call) =>
          call.environment.JUDGE_ENABLED === "false" &&
          call.environment.JUDGE_API_KEY === undefined,
      ),
    ).toBe(true);
    const judgeCall = valid.calls.find((call) => call.args[0] === "dist/acceptance-judge.js");
    expect(judgeCall?.environment).toMatchObject({
      JUDGE_ENABLED: "true",
      JUDGE_API_KEY: validModelEnvironment.MODEL_API_KEY,
      MODEL_API_KEY: "acceptance-unused-policy-key",
    });
  });
});

describe("live environment boundary", () => {
  it("copies only required model, judge, profile, runtime, and safe process fields", () => {
    const source = {
      ...validModelEnvironment,
      ...judgeEnvironment(),
      PATH: "/bin",
      JUDGE_ENABLED: "true",
      DOCSFAB_RETRY_MAX_DELAY_MS: "1000",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      UNRELATED_TOKEN: "secret",
    };
    const environment = liveAcceptanceEnvironment(source, "/operator/state");

    expect(environment).toMatchObject({
      PATH: "/bin",
      MODEL_API_KEY: validModelEnvironment.MODEL_API_KEY,
      JUDGE_ENABLED: "false",
      DOCSFAB_RETRY_MAX_DELAY_MS: "1000",
      DOCSFAB_STATE_DIR: "/operator/state",
    });
    expect(environment.JUDGE_API_KEY).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.UNRELATED_TOKEN).toBeUndefined();

    const judge = liveAcceptanceEnvironment(source, "/operator/state", true);
    expect(judge).toMatchObject({
      MODEL_API_KEY: "acceptance-unused-policy-key",
      JUDGE_API_KEY: validModelEnvironment.MODEL_API_KEY,
      JUDGE_ENABLED: "true",
    });
  });
});
