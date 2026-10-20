// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab profile inspect` must not answer its own failure with "Run
 * `docsfab profile inspect`", and a lapsed-review profile of real size must
 * inspect instead of failing on an invented 8k lid.
 *
 * Every case drives the shipped handler (`handleProfileCommand`) or the CLI
 * entry, then reads the operator envelope the bin boundary prints.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Doctor readiness seams for the ready-host cases below; empty elsewhere, so
// every other doctor call runs the real readiness.
const readinessSeams = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));
vi.mock("../src/doctor-readiness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/doctor-readiness.js")>();
  return {
    ...actual,
    inspectDoctorReadiness: (options: Record<string, unknown> = {}) =>
      actual.inspectDoctorReadiness({ ...readinessSeams.options, ...options }),
  };
});

import { handleDoctorCommand } from "../src/cli/commands/doctor.js";
import { handleProfileCommand } from "../src/cli/commands/profile.js";
import { prepareRunPreflight } from "../src/cli/run/preflight.js";
import type { CliRunInvocation } from "../src/cli/run/request.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { modelEvidenceDefectMessage } from "../src/model/profile-inspection.js";
import { remediationText } from "../src/operator/remediation.js";
import { resolveDocsFabPrivateRoots } from "../src/init.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const execFile = promisify(execFileCallback);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(runtimeRoot, "src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
// Local budgets in ms, as in cli-help.test.ts: a tsx CLI child can exceed the
// default case budget on a loaded host. In CI each case gets at least the
// shared test.ciTimeoutMs, and the child keeps its share so it fails first.
const localCliProcessMs = 20_000;
const localCliCaseMs = 30_000;

const LAPSED = {
  MODEL_PROFILE_EFFECTIVE_DATE: "2020-01-01",
  MODEL_PROFILE_REVIEW_AFTER: "2020-02-01",
};
const PROFILE_KEYS = Object.keys(validModelEnvironment);
const JUDGE_ENVIRONMENT = Object.fromEntries(
  Object.entries(validModelEnvironment).map(([key, value]) => [
    key === "MODEL_ID" ? "JUDGE_MODEL_ID" : key.replace(/^MODEL_/u, "JUDGE_"),
    value,
  ]),
);

// Exact operator text, spelled out here rather than rebuilt from the table under
// test: a key that is only a substring (MODEL_ID inside JUDGE_MODEL_ID) fails.
const MODEL_ID_RULE =
  "use letters, digits, dots, underscores, or hyphens in slash-separated segments that are not empty, `.`, or `..`";
const PROVIDER_RULE = "use lowercase letters, digits, dots, underscores, or hyphens";
const identifierMessage = (field: string, rule: string, key: string): string =>
  `Configured model profile evidence is unavailable: the configured ${field} cannot form evidence (${rule}). ${key} supplies it.`;
const POLICY_MODEL_ID_MESSAGE = identifierMessage("model id", MODEL_ID_RULE, "MODEL_ID");
const JUDGE_MODEL_ID_MESSAGE = identifierMessage("model id", MODEL_ID_RULE, "JUDGE_MODEL_ID");
const POLICY_PROVIDER_MESSAGE = identifierMessage("provider id", PROVIDER_RULE, "MODEL_PROVIDER");

/** The operator must be told something other than the command that just failed. */
function expectNonLoopingAction(nextAction: string | undefined, argv: readonly string[]): void {
  expect(nextAction).toBeDefined();
  const invoked = new RegExp(`docsfab profile ${argv[0]!}(?![\\w-])`, "u");
  expect(nextAction).not.toMatch(invoked);
}

async function inspectFailure(argv: string[]) {
  const failure = await handleProfileCommand(argv).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  return {
    error: failure as Error,
    envelope: toOperatorErrorEnvelope(failure),
  };
}

describe("profile inspect remediation (#1094)", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    for (const key of [...PROFILE_KEYS, ...Object.keys(JUDGE_ENVIRONMENT), "JUDGE_ENABLED"]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("DOCSFAB_ACTIVE_EXECUTION_PROFILE", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function stubProfile(environment: Record<string, string>): void {
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  }

  it("inspects a real-sized profile past its review date as current, with the advisory", async () => {
    stubProfile({ ...validModelEnvironment, ...LAPSED });
    expect(LAPSED.MODEL_PROFILE_REVIEW_AFTER < new Date().toISOString().slice(0, 10)).toBe(true);
    await handleProfileCommand(["inspect", "--json"]);
    const report = JSON.parse(logged.join("\n")) as {
      runtime: { profileStatus: string; effectiveLimitReason: string };
    };
    expect(report.runtime).toMatchObject({
      profileStatus: "current",
      effectiveLimitReason: "none",
    });

    logged.length = 0;
    await handleProfileCommand(["inspect"]);
    const human = logged.join("\n");
    expect(human).toContain("Profile status: current");
    expect(human).toContain("Effective input limit: 128000");
    expect(human).toContain("Effective output limit: 16384");
    expect(human).toContain("Effective context window: 128000");
    expect(human).toContain(
      `Review overdue: the profile review date ${LAPSED.MODEL_PROFILE_REVIEW_AFTER} has passed. This is a reminder only; DocsFab still uses the configured limits, capabilities, and prices.`,
    );
    expect(human).not.toContain(remediationText("profile-review-lapsed"));
  });

  it("prints no review advisory for a profile whose review date is ahead", async () => {
    // Adjacent condition: the shipped fixture reviews in 2099.
    stubProfile(validModelEnvironment);
    await handleProfileCommand(["inspect"]);
    const human = logged.join("\n");
    expect(human).toContain("Profile status: current");
    expect(human).not.toContain("Review overdue");
  });

  it.each([
    [
      "MODEL_ID",
      ["inspect"],
      { ...validModelEnvironment, MODEL_ID: "llama3:8b" },
      POLICY_MODEL_ID_MESSAGE,
    ],
    [
      "MODEL_PROVIDER",
      ["inspect"],
      { ...validModelEnvironment, MODEL_PROVIDER: "Test Provider" },
      POLICY_PROVIDER_MESSAGE,
    ],
    [
      "JUDGE_MODEL_ID",
      ["inspect", "--judge"],
      {
        ...validModelEnvironment,
        ...JUDGE_ENVIRONMENT,
        JUDGE_ENABLED: "true",
        JUDGE_MODEL_ID: "judge:1",
      },
      JUDGE_MODEL_ID_MESSAGE,
    ],
  ] as const)(
    "names %s when the configured identifier cannot form evidence",
    async (key, argv, environment, message) => {
      stubProfile(environment);
      const { envelope } = await inspectFailure([...argv]);
      expect(envelope.code).toBe("profile-evidence-invalid");
      expect(envelope.message).toBe(message);
      expect(envelope.message).toMatch(new RegExp(`(?<![A-Z_])${key} supplies it\\.$`, "u"));
      expect(envelope.message).not.toMatch(key.startsWith("JUDGE_") ? /\bMODEL_/u : /JUDGE_/u);
      expect(envelope.message).toMatch(/model profile evidence is unavailable/iu);
      expect(envelope.message).not.toContain(environment[key as keyof typeof environment]);
      expect(envelope.failure?.class).toBe("operator-input");
      expect(envelope.nextAction).toBe(remediationText("profile-evidence-invalid"));
      expectNonLoopingAction(envelope.nextAction, argv);
    },
  );

  it("leaves a configuration failure that is not an evidence defect on its own code", async () => {
    // Adjacent condition: a missing required key fails before evidence exists
    // and must not be relabelled as an evidence defect.
    const { MODEL_CONTEXT_WINDOW: _dropped, ...missing } = validModelEnvironment;
    stubProfile(missing);
    const { envelope } = await inspectFailure(["inspect"]);
    expect(envelope.code).not.toBe("profile-evidence-invalid");
    expect(envelope.message).toContain("MODEL_CONTEXT_WINDOW");
  });

  it("prints the evidence situation through the CLI boundary", {
    timeout: testTimeoutMs(localCliCaseMs),
  }, async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-1094-")));
    try {
      const environment = { ...validModelEnvironment, MODEL_ID: "llama3:8b" };
      await writeFile(
        resolve(root, ".env"),
        `${Object.entries(environment)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n")}\n`,
        { mode: 0o600 },
      );
      const failure = await execFile(
        process.execPath,
        ["--import", tsxLoader, cliPath, "profile", "inspect"],
        {
          cwd: root,
          timeout: nestedDeadlineMs(localCliProcessMs, localCliCaseMs),
          env: {
            PATH: process.env.PATH,
            LC_ALL: "C",
            DOCSFAB_CONFIG_ROOT: root,
            DOCSFAB_SKILL_CRATE_DIR: resolve(runtimeRoot, "skill-crate"),
          },
        },
      ).then(
        () => undefined,
        (error: unknown) => error as { stderr: string; code: number },
      );
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain("code: profile-evidence-invalid");
      // The message is the first stderr line; the next action names JUDGE_*
      // generically, so pin the message line itself.
      const [messageLine] = failure?.stderr.split("\n") ?? [];
      expect(messageLine).toBe(POLICY_MODEL_ID_MESSAGE);
      expect(failure?.stderr).not.toContain("llama3:8b");
      expect(failure?.stderr).toContain(
        `Next action: ${remediationText("profile-evidence-invalid")}`,
      );
      expect(failure?.stderr).not.toMatch(/Next action:.*docsfab profile inspect/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("model evidence defect messages (#1094)", () => {
  it("names every setting that supplies a multi-key field for the selected purpose", () => {
    const message = modelEvidenceDefectMessage("pricing", "judge");
    for (const key of [
      "JUDGE_INPUT_COST_PER_MILLION",
      "JUDGE_OUTPUT_COST_PER_MILLION",
      "JUDGE_CACHE_READ_COST_PER_MILLION",
      "JUDGE_CACHE_WRITE_COST_PER_MILLION",
    ]) {
      expect(message).toContain(key);
    }
    expect(message).not.toMatch(/\bMODEL_/u);
    expect(message).toMatch(/ supply it\.$/u);
  });

  it("names the model id setting of the selected purpose exactly", () => {
    expect(modelEvidenceDefectMessage("model", "policy")).toBe(POLICY_MODEL_ID_MESSAGE);
    expect(modelEvidenceDefectMessage("model", "judge")).toBe(JUDGE_MODEL_ID_MESSAGE);
  });

  it("does not send the operator to a setting for a projector-owned defect", () => {
    // Adjacent condition: the digest is DocsFab's own; no key may be named.
    const message = modelEvidenceDefectMessage("digest", "policy");
    expect(message).toContain("no MODEL_* setting supplies it");
    expect(message).not.toMatch(/\bMODEL_[A-Z]/u);
  });
});

describe("IA corpus preflight model evidence (#1094, internal-only path)", () => {
  // The unit call keeps parity with `profile inspect` for a branch no enabled
  // CLI entry reaches (`run ia-analysis` is parked).
  async function corpusPreflight(model: typeof validModelConfig) {
    const source = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-1094-ia-")));
    const missing = resolve(source, "absent.json");
    const invocation = {
      request: {
        workflow: "ia-analysis",
        runId: "run-1094",
        corpusExecutionAuthorizationPath: missing,
        corpusReviewerPolicyPath: missing,
        corpusCaseId: "case-1094",
        corpusTestedRevision: "a".repeat(40),
      },
      config: { projectRoot: source, model },
      output: {},
    } as unknown as CliRunInvocation;
    try {
      return await prepareRunPreflight(invocation, {
        sourcePath: source,
      } as unknown as RepositoryWorkspace).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  }

  it("refuses an unusable model identifier with the evidence situation", async () => {
    const failure = await corpusPreflight({
      ...validModelConfig,
      modelId: "llama3:8b",
    });
    const envelope = toOperatorErrorEnvelope(failure);
    expect(envelope.code).toBe("profile-evidence-invalid");
    // The corpus preflight runs the policy model: MODEL_ID, not JUDGE_MODEL_ID.
    expect(envelope.message).toBe(POLICY_MODEL_ID_MESSAGE);
    expect(envelope.message).not.toMatch(/JUDGE_/u);
    expect(envelope.message).not.toContain("llama3:8b");
  });

  it("lets valid evidence through to the corpus file checks", async () => {
    // Adjacent condition: valid evidence reaches the content/file checks.
    // A public distribution may refuse the internal capability; the internal
    // distribution reaches the missing authorization. Neither is a profile defect.
    const failure = await corpusPreflight(validModelConfig);
    expect(failure).toBeInstanceOf(Error);
    expect(toOperatorErrorEnvelope(failure).code).not.toBe("profile-evidence-invalid");
  });
});

describe("doctor re-checks profile evidence (#1094)", () => {
  // The `profile-evidence-invalid` next action confirms the correction with
  // plain `docsfab doctor`, so doctor must apply the same evidence rule, and
  // `doctor --catalog` must not be sent back to itself.
  let logged: string[];
  let root: string;

  beforeEach(async () => {
    logged = [];
    const capture = (line: unknown) => {
      logged.push(String(line));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    for (const key of [...PROFILE_KEYS, ...Object.keys(JUDGE_ENVIRONMENT), "JUDGE_ENABLED"]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("DOCSFAB_ACTIVE_EXECUTION_PROFILE", undefined);
    // An empty, non-repository root: doctor stays blocked on the repository,
    // prints readiness, and does not reach catalog I/O.
    root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-1094-doctor-")));
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
  });

  afterEach(async () => {
    process.exitCode = undefined;
    readinessSeams.options = {};
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function doctor(
    environment: Record<string, string>,
    argv: readonly string[],
    repository = root,
  ) {
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    await handleDoctorCommand([...argv, "--repo", repository]);
    return { output: logged.join("\n"), exitCode: process.exitCode };
  }

  /**
   * An attached repository whose git, glab and private state are all ready,
   * so the provider area alone decides whether doctor stops at readiness.
   * The profile still comes from the real loader and the stubbed environment.
   */
  async function readyHost(): Promise<string> {
    const repository = resolve(root, "repository");
    const home = resolve(root, "home");
    await Promise.all([mkdir(repository), mkdir(home)]);
    const project = {
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
    };
    await writeFile(resolve(repository, ".docsfab.json"), `${JSON.stringify(project)}\n`, {
      mode: 0o600,
    });
    const environment = { XDG_STATE_HOME: resolve(root, "state") };
    for (const path of Object.values(resolveDocsFabPrivateRoots(repository, environment, home))) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    const revision = "a".repeat(40);
    const replies: Record<string, string> = {
      "git --version": "git version 2.50.0\n",
      "git rev-parse --show-toplevel": `${repository}\n`,
      "git symbolic-ref --quiet --short HEAD": "main\n",
      "git rev-parse --verify HEAD^{commit}": `${revision}\n`,
      [`git cat-file -e ${revision}^{commit}`]: "",
      "git config --get user.name": "Operator\n",
      "git config --get user.email": "operator@example.test\n",
      "git ls-tree --name-only HEAD -- .docsfab.json": ".docsfab.json\n",
      "git status --porcelain=v1 --untracked-files=all": "",
      "git remote get-url --all origin": "https://gitlab.example.test/group/project.git\n",
      "glab --version": "glab 1.0\n",
      "glab config get host": "gitlab.example.test\n",
      "npm --version": "11.0.0\n",
    };
    readinessSeams.options = {
      environment,
      homeDirectory: home,
      commands: {
        run: async (command: string, args: readonly string[]) => {
          const stdout = replies[`${command} ${args.join(" ")}`];
          return stdout === undefined ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout };
        },
        probeCredential: async () => "present",
      },
      validateConfiguration: async () => undefined,
    };
    return repository;
  }

  it.each([[[] as string[]], [["--catalog"]]])(
    "doctor %j on a ready host blocks the provider and names plain doctor to confirm",
    async (argv) => {
      const repository = await readyHost();
      const { output, exitCode } = await doctor(
        { ...validModelEnvironment, MODEL_ID: "llama3:8b" },
        argv,
        repository,
      );
      // Readiness stops here only because the provider area is blocked; a
      // non-blocking diagnostic would let `--catalog` reach the inspection.
      const normalizedOutput = output.replaceAll(/\s+/gu, " ");
      expect(normalizedOutput).toContain("provider blocked");
      expect(normalizedOutput).not.toMatch(/(?:^| )(?!(?:provider) )[a-z-]+ blocked/u);
      expect(exitCode).toBe(1);
      expect(normalizedOutput).toContain("Code: provider-profile-evidence-invalid");
      expect(normalizedOutput).toContain(`Explanation: ${POLICY_MODEL_ID_MESSAGE}`);
      expect(normalizedOutput).not.toContain("llama3:8b");
      // Non-looping: the printed confirmation is plain doctor, not the catalog
      // variant or the profile subcommand that raised the envelope code.
      expect(normalizedOutput).toContain(
        `Next action: ${remediationText("profile-evidence-invalid")}`,
      );
      expect(normalizedOutput).toMatch(/run `docsfab doctor`,/u);
      expect(normalizedOutput).not.toMatch(/docsfab doctor --catalog|docsfab profile inspect/u);
    },
  );

  it("names both settings when the policy and judge profiles are both defective", async () => {
    const { output } = await doctor(
      {
        ...validModelEnvironment,
        ...JUDGE_ENVIRONMENT,
        JUDGE_ENABLED: "true",
        MODEL_ID: "llama3:8b",
        JUDGE_MODEL_ID: "judge:1",
      },
      [],
    );
    expect(output).toContain(`Explanation: ${POLICY_MODEL_ID_MESSAGE} ${JUDGE_MODEL_ID_MESSAGE}`);
  });

  it("names the judge setting when the enabled judge profile is the defective one", async () => {
    const { output } = await doctor(
      {
        ...validModelEnvironment,
        ...JUDGE_ENVIRONMENT,
        JUDGE_ENABLED: "true",
        JUDGE_MODEL_ID: "judge:1",
      },
      [],
    );
    expect(output).toContain(`Explanation: ${JUDGE_MODEL_ID_MESSAGE}`);
    expect(output).not.toContain(POLICY_MODEL_ID_MESSAGE);
  });

  it("stops reporting the defect once the named setting is corrected", async () => {
    // Adjacent condition: valid evidence adds no evidence diagnostic, so the
    // confirmation step passes only when the defect is fixed.
    const { output } = await doctor(validModelEnvironment, []);
    expect(output).toContain("Code: repository-unattached");
    expect(output.replaceAll(/\s+/gu, " ")).toContain("provider ready");
    expect(output).not.toContain("provider-profile-evidence-invalid");
  });

  it("prints the review advisory on an otherwise ready host and does not block", async () => {
    // A passed review date alone must not block doctor or name the
    // old stale code; the advisory rides the ready output instead.
    expect(LAPSED.MODEL_PROFILE_REVIEW_AFTER < new Date().toISOString().slice(0, 10)).toBe(true);
    const repository = await readyHost();
    const { output, exitCode } = await doctor(
      { ...validModelEnvironment, ...LAPSED },
      [],
      repository,
    );
    const normalizedOutput = output.replaceAll(/\s+/gu, " ");
    expect(normalizedOutput).toContain("provider ready");
    expect(normalizedOutput).toContain("local-review readiness: ready; blockers: none");
    expect(exitCode).not.toBe(1);
    expect(normalizedOutput).not.toContain("provider-profile-stale");
    expect(normalizedOutput).not.toContain("provider-profile-evidence-invalid");
    expect(normalizedOutput).toContain("DocsFab configuration: ready");
    expect(normalizedOutput).not.toContain("Limit reason: none (approved metadata is current)");
    expect(normalizedOutput).toContain(
      `Review overdue: the profile review date ${LAPSED.MODEL_PROFILE_REVIEW_AFTER} has passed.`,
    );
  });

  it("prints no review advisory on a ready host whose review date is ahead", async () => {
    // Adjacent condition: same ready host, review date in 2099.
    const repository = await readyHost();
    const { output } = await doctor(validModelEnvironment, [], repository);
    expect(output).toContain("DocsFab configuration: ready");
    expect(output).not.toContain("Review overdue");
  });
});
