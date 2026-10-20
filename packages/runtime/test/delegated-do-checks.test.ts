// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleDoCommand,
  parseDoArguments,
  type DoCommandOptions,
} from "../src/cli/commands/do.js";
import { DelegatedCheckOperatorError } from "../src/cli/commands/do-parse.js";
import {
  createDelegatedRequest,
  createDelegatedRequirement,
  inspectPauseDelegatedTask,
  resumeDelegatedTask,
} from "../src/delegated-task/continuation.js";
import {
  DelegatedTaskResultError,
  decodeDelegatedTaskResult,
  delegatedTaskContractKit,
} from "../src/delegated-task/result-contract.js";
import { DelegatedTaskStateStore } from "../src/delegated-task/task-state.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { temporaryRoots } from "./helpers/temp.js";

const directories = temporaryRoots();
const REVISION = "a".repeat(40);
const NOW = () => new Date("2026-10-05T20:00:00.000Z");
const SCRIPTS = { test: "node -e 0", "docs:check": "node -e 0" };

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function fixture(manifest: string | null = JSON.stringify({ scripts: SCRIPTS })) {
  const root = await directories.create("docsfab-delegated-checks-");
  const repositoryPath = join(root, "repo");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await writeFile(join(repositoryPath, "docs", "api.md"), "# API\n", "utf8");
  await writeFile(join(repositoryPath, "docs", "reference.md"), "json_flag=--json\n", "utf8");
  if (manifest !== null) await writeFile(join(repositoryPath, "package.json"), manifest);
  return { root, repositoryPath, stateDirectory: join(root, "state") };
}

function completedReadResult() {
  return {
    kind: "docsfab-delegated-task-result" as const,
    status: "completed" as const,
    answer: "The API page exists ([source-line 1]).",
    transcript: [
      { kind: "tool-call" as const, name: "read", arguments: { path: "docs/api.md" } },
      { kind: "tool-result" as const, name: "read", isError: false, text: "# API\n" },
    ],
    childWorkflows: [],
  };
}

function spies() {
  return {
    runDelegatedTask: vi.fn(async () => completedReadResult()),
    inspectPause: vi.fn(inspectPauseDelegatedTask),
    resume: vi.fn(resumeDelegatedTask),
    checks: vi.fn(async (input: { checks: readonly { checkId: string }[] }) =>
      input.checks.map((check, index) => ({
        checkId: check.checkId,
        state: "passed" as const,
        receiptSha256: String(index).repeat(64),
      })),
    ),
    authority: vi.fn(async () => ({ kind: "docsfab-delegated-task-authority" }) as never),
  };
}

function options(
  repositoryPath: string,
  stateDirectory: string,
  spy: ReturnType<typeof spies>,
  extras: DoCommandOptions = {},
): DoCommandOptions {
  return {
    stateDirectory,
    now: NOW,
    inspectDelegatedWorkspaceBasis: async () => ({
      canonicalRepositoryPath: repositoryPath,
      committedHeadRevision: REVISION,
      dirtyPaths: [],
      workspace: {
        strategy: "tracked-export" as const,
        disposable: true as const,
        origin: "committed-head" as const,
        revision: REVISION,
      },
    }),
    createDelegatedTaskAuthority: spy.authority,
    runDelegatedTask: spy.runDelegatedTask,
    inspectPauseDelegatedTask: spy.inspectPause,
    resumeDelegatedTask: spy.resume,
    runRequestedDelegatedChecks: spy.checks,
    runWorkflow: async () => {
      throw new Error("catalog runner must not run");
    },
    admitCatalogWorkflow: async () => {
      throw new Error("catalog admission must not run");
    },
    signal: new AbortController().signal,
    ...extras,
  };
}

async function quietly<T>(fn: () => Promise<T>): Promise<{ stdout: string; value: T }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  console.error = () => undefined;
  try {
    const value = await fn();
    return { stdout: logs.join("\n"), value };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function refusal(promise: Promise<unknown>): Promise<DelegatedCheckOperatorError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DelegatedCheckOperatorError);
  const envelope = toOperatorErrorEnvelope(error);
  expect(envelope.code).toBe("cli-usage");
  expect(envelope.failure?.class).toBe("operator-input");
  return error as DelegatedCheckOperatorError;
}

function parseRefusal(args: string[]): DelegatedCheckOperatorError {
  return refusalSync(() => parseDoArguments(args));
}

function refusalSync(fn: () => unknown): DelegatedCheckOperatorError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DelegatedCheckOperatorError);
  expect(toOperatorErrorEnvelope(caught).failure?.class).toBe("operator-input");
  return caught as DelegatedCheckOperatorError;
}

async function expectNothingRan(spy: ReturnType<typeof spies>, stateDirectory: string) {
  expect(spy.authority).not.toHaveBeenCalled();
  expect(spy.inspectPause).not.toHaveBeenCalled();
  expect(spy.runDelegatedTask).not.toHaveBeenCalled();
  expect(spy.checks).not.toHaveBeenCalled();
  const stored = await readdir(join(stateDirectory, "delegated-tasks")).catch(() => []);
  expect(stored).toEqual([]);
}

function currentAuthority(spy: ReturnType<typeof spies>) {
  return spy.inspectPause.mock.calls[0]![0].currentAuthority;
}

function pauseRequirements(spy: ReturnType<typeof spies>) {
  return spy.inspectPause.mock.calls[0]![0].originalRequirements.map(
    (requirement) => `${requirement.id}:${requirement.kind}:${requirement.targetLocator}`,
  );
}

function ranChecks(spy: ReturnType<typeof spies>) {
  return spy.checks.mock.calls.map((call) => call[0].checks);
}

describe("delegated do checks come from --check, never from request text", () => {
  const PROSE = "Review docs/api.md. Run npm test and npm run docs:check.";

  it("row 1: runs no check that the request merely mentions", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const spy = spies();
    const printed = await quietly(() =>
      handleDoCommand(
        ["--delegate", PROSE, "--repo", repositoryPath, "--no-input", "--json"],
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(spy.checks).not.toHaveBeenCalled();
    expect(currentAuthority(spy).check).toBe(false);
    expect(pauseRequirements(spy)).toEqual(["R1:artifact:answer"]);
    const decoded = decodeDelegatedTaskResult(JSON.parse(printed.stdout));
    expect(decoded.requirements.filter((requirement) => requirement.kind === "check")).toEqual([]);
  });

  it("row 1 control: one --check runs exactly that script, not the ones the prose names", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const spy = spies();
    const printed = await quietly(() =>
      handleDoCommand(
        [
          "--delegate",
          PROSE,
          "--repo",
          repositoryPath,
          "--check",
          "docs:check",
          "--no-input",
          "--json",
        ],
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(ranChecks(spy)).toEqual([
      [{ checkId: "npm-run-docs:check", argv: ["npm", "run", "docs:check"] }],
    ]);
    expect(currentAuthority(spy).check).toBe(true);
    expect(pauseRequirements(spy)).toEqual(["R1:artifact:answer", "C1:check:npm-run-docs:check"]);
    const decoded = decodeDelegatedTaskResult(JSON.parse(printed.stdout));
    expect(decoded.checkState).toBe("passed");
    expect(decoded.fulfillment).toBe("complete");
  });

  it("row 1 control: two --check flags run in the order given", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const spy = spies();
    await quietly(() =>
      handleDoCommand(
        [
          "--delegate",
          PROSE,
          "--repo",
          repositoryPath,
          "--check",
          "docs:check",
          "--check",
          "test",
          "--no-input",
          "--json",
        ],
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(ranChecks(spy)).toEqual([
      [
        { checkId: "npm-run-docs:check", argv: ["npm", "run", "docs:check"] },
        { checkId: "npm-run-test", argv: ["npm", "run", "test"] },
      ],
    ]);
    expect(pauseRequirements(spy)).toEqual([
      "R1:artifact:answer",
      "C1:check:npm-run-docs:check",
      "C2:check:npm-run-test",
    ]);
  });

  it("row 2: refuses an undeclared script before authority, pause, driver, or state", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const spy = spies();
    const error = await refusal(
      handleDoCommand(
        ["--delegate", PROSE, "--repo", repositoryPath, "--check", "nope", "--no-input"],
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(error.reason).toBe("undeclared-script");
    await expectNothingRan(spy, stateDirectory);
  });

  it("row 3: admits only an own string script, never an inherited or non-string one", async () => {
    // `__proto__` never reaches the manifest: its leading `_` fails the check id grammar.
    const cases: [string, string][] = [
      ["toString", "undeclared-script"],
      ["constructor", "undeclared-script"],
      ["hasOwnProperty", "undeclared-script"],
      ["__proto__", "invalid-check-id"],
    ];
    for (const [name, reason] of cases) {
      const { repositoryPath, stateDirectory } = await fixture();
      const spy = spies();
      const error = await refusal(
        handleDoCommand(
          ["--delegate", PROSE, "--repo", repositoryPath, "--check", name, "--no-input"],
          options(repositoryPath, stateDirectory, spy),
        ),
      );
      expect({ name, reason: error.reason }).toEqual({ name, reason });
      await expectNothingRan(spy, stateDirectory);
    }
    const numeric = await fixture(JSON.stringify({ scripts: { "docs:check": 1, test: "x" } }));
    const numericSpy = spies();
    const numericError = await refusal(
      handleDoCommand(
        [
          "--delegate",
          PROSE,
          "--repo",
          numeric.repositoryPath,
          "--check",
          "docs:check",
          "--no-input",
        ],
        options(numeric.repositoryPath, numeric.stateDirectory, numericSpy),
      ),
    );
    expect(numericError.reason).toBe("undeclared-script");
    await expectNothingRan(numericSpy, numeric.stateDirectory);
  });

  it("row 4: refuses a missing, malformed, or script-less manifest with its own reason", async () => {
    const cases: [string | null, string][] = [
      [null, "manifest-missing"],
      ["{ not json", "manifest-invalid"],
      ["[]", "manifest-invalid"],
      [JSON.stringify({ scripts: ["docs:check"] }), "manifest-invalid"],
      [JSON.stringify({ scripts: null }), "manifest-invalid"],
      [JSON.stringify({ name: "no-scripts" }), "undeclared-script"],
    ];
    for (const [manifest, reason] of cases) {
      const { repositoryPath, stateDirectory } = await fixture(manifest);
      const spy = spies();
      const error = await refusal(
        handleDoCommand(
          ["--delegate", PROSE, "--repo", repositoryPath, "--check", "docs:check", "--no-input"],
          options(repositoryPath, stateDirectory, spy),
        ),
      );
      expect({ manifest, reason: error.reason }).toEqual({ manifest, reason });
      await expectNothingRan(spy, stateDirectory);
    }
  });

  it("row 4: a symlinked manifest or a path that is not a directory is unreadable, not missing", async () => {
    const linked = await fixture(null);
    await writeFile(join(linked.root, "outside.json"), JSON.stringify({ scripts: SCRIPTS }));
    await symlink(join(linked.root, "outside.json"), join(linked.repositoryPath, "package.json"));
    const linkedSpy = spies();
    const linkedError = await refusal(
      handleDoCommand(
        ["--delegate", PROSE, "--repo", linked.repositoryPath, "--check", "test", "--no-input"],
        options(linked.repositoryPath, linked.stateDirectory, linkedSpy),
      ),
    );
    expect(linkedError.reason).toBe("manifest-unreadable");
    await expectNothingRan(linkedSpy, linked.stateDirectory);

    // ENOTDIR is a stat failure other than absence, so it must not read as missing.
    const notDirectory = await fixture();
    const filePath = join(notDirectory.repositoryPath, "docs", "api.md");
    const fileSpy = spies();
    const fileError = await refusal(
      handleDoCommand(
        ["--delegate", PROSE, "--repo", notDirectory.repositoryPath, "--check", "test"],
        options(filePath, notDirectory.stateDirectory, fileSpy),
      ),
    );
    expect(fileError.reason).toBe("manifest-unreadable");
    expect(fileError.message).not.toBe(linkedError.message);

    const directoryManifest = await fixture(null);
    await mkdir(join(directoryManifest.repositoryPath, "package.json"));
    const directorySpy = spies();
    const directoryError = await refusal(
      handleDoCommand(
        ["--delegate", PROSE, "--repo", directoryManifest.repositoryPath, "--check", "test"],
        options(directoryManifest.repositoryPath, directoryManifest.stateDirectory, directorySpy),
      ),
    );
    expect(directoryError.reason).toBe("manifest-unreadable");
  });

  it("row 4 control: a manifest with extra fields and workspaces still admits a declared script", async () => {
    const { repositoryPath, stateDirectory } = await fixture(
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"], scripts: SCRIPTS }),
    );
    const spy = spies();
    await quietly(() =>
      handleDoCommand(
        ["--delegate", PROSE, "--repo", repositoryPath, "--check", "test", "--no-input", "--json"],
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(ranChecks(spy)).toEqual([[{ checkId: "npm-run-test", argv: ["npm", "run", "test"] }]]);
  });

  it("row 5: refuses a duplicate, a missing value, and a value that is another flag", () => {
    const base = ["--delegate", PROSE, "--repo", "/tmp/docs"];
    expect(parseRefusal([...base, "--check", "a", "--check", "a"]).reason).toBe("check-duplicated");
    expect(parseRefusal([...base, "--check"]).reason).toBe("check-value-missing");
    // Boolean flags are stripped before value options are read, so `--check --json test`
    // must refuse rather than bind `test`.
    expect(parseRefusal([...base, "--check", "--json", "test"]).reason).toBe("check-value-missing");
    expect(parseRefusal([...base, "--check", "-x"]).reason).toBe("invalid-check-id");
    expect(parseDoArguments([...base, "--check", "b", "--check", "a"]).checkScripts).toEqual([
      "b",
      "a",
    ]);
    expect(
      parseDoArguments([...base, "--check", "lint:md", "--check", "docs/x_y.z-1"]).checkScripts,
    ).toEqual(["lint:md", "docs/x_y.z-1"]);
    expect(parseDoArguments(base).checkScripts).toBeUndefined();
  });

  it("row 5b: refuses a declared name outside the check id grammar before anything spawns", async () => {
    const { repositoryPath, stateDirectory } = await fixture(
      JSON.stringify({ scripts: { ...SCRIPTS, "docs build": "x", "lint+md": "x" } }),
    );
    for (const name of ["docs build", "lint+md"]) {
      const spy = spies();
      const error = await refusal(
        handleDoCommand(
          ["--delegate", PROSE, "--repo", repositoryPath, "--check", name, "--no-input"],
          options(repositoryPath, stateDirectory, spy),
        ),
      );
      expect(error.reason).toBe("invalid-check-id");
      await expectNothingRan(spy, stateDirectory);
    }
    // The composed `npm-run-<name>` id carries the length bound, not only the name.
    const longName = "a".repeat(250);
    expect(() => delegatedTaskContractKit.identifier(longName)).not.toThrow();
    expect(
      parseRefusal(["--delegate", PROSE, "--repo", repositoryPath, "--check", longName]).reason,
    ).toBe("invalid-check-id");
  });

  it("row 5b scope: only the grammar refusal becomes operator input; other failures propagate", () => {
    const args = ["--delegate", PROSE, "--repo", "/tmp/docs", "--check", "docs:check"];
    const defect = new TypeError("identifier kit defect");
    vi.spyOn(delegatedTaskContractKit, "identifier").mockImplementation(() => {
      throw defect;
    });
    expect(() => parseDoArguments(args)).toThrow(defect);
    vi.spyOn(delegatedTaskContractKit, "identifier").mockImplementation(() => {
      throw new DelegatedTaskResultError("invalid-shape");
    });
    expect(() => parseDoArguments(args)).toThrow(DelegatedTaskResultError);
  });

  it("row 6: refuses --check outside delegated mode with its own reason", () => {
    const error = parseRefusal([PROSE, "--repo", "/tmp/docs", "--check", "docs:check"]);
    expect(error.reason).toBe("check-requires-delegate");
    expect(error.message).not.toMatch(/^Unknown do option/u);
    expect(error.message).not.toBe("docsfab do --answers requires --resume <task-id>.");
    expect(
      parseDoArguments(["--delegate", PROSE, "--repo", "/tmp/docs", "--check", "docs:check"]),
    ).toMatchObject({ delegate: true, checkScripts: ["docs:check"] });
    expect(
      parseDoArguments(["--resume", "task:x", "--answers", "a.json", "--check", "docs:check"]),
    ).toMatchObject({ resumeTaskId: "task:x", checkScripts: ["docs:check"] });
  });

  it("row 6: --check does not lift delegated conflicts", () => {
    const base = ["--delegate", PROSE, "--repo", "/tmp/docs", "--check", "test"];
    expect(() => parseDoArguments([...base, "--route-only"])).toThrow(
      /cannot be combined with --route-only/u,
    );
    expect(() => parseDoArguments([...base, "--dry-run"])).toThrow(
      /cannot be combined with --dry-run/u,
    );
  });
});

async function pauseTask(
  repositoryPath: string,
  stateDirectory: string,
  taskId: string,
  request: string,
  flags: string[] = [],
) {
  const spy = spies();
  const paused = await quietly(() =>
    handleDoCommand(
      ["--delegate", request, "--repo", repositoryPath, ...flags, "--no-input", "--json"],
      options(repositoryPath, stateDirectory, spy, { taskId }),
    ),
  );
  expect(decodeDelegatedTaskResult(JSON.parse(paused.stdout)).stopReason).toBe("needs-input");
  expect(spy.runDelegatedTask).not.toHaveBeenCalled();
  const answersPath = join(stateDirectory, `${taskId.replace(":", "-")}.json`);
  await writeFile(answersPath, '{"q-target":"docs/api.md"}', "utf8");
  return { answersPath, pauseSpy: spy };
}

function resumeArgs(taskId: string, answersPath: string, repositoryPath: string, flags: string[]) {
  return ["--resume", taskId, "--answers", answersPath, "--repo", repositoryPath, ...flags];
}

describe("delegated resume takes its check grant only from its own --check flags", () => {
  const PROSE_PAUSE = "Document docs/guide.md. Then run npm run docs:check.";

  it("row 7: a retained outcome that mentions npm run grants and runs nothing", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const { answersPath } = await pauseTask(
      repositoryPath,
      stateDirectory,
      "task:prose-resume",
      PROSE_PAUSE,
    );
    const store = new DelegatedTaskStateStore({
      directory: join(stateDirectory, "delegated-tasks"),
    });
    expect((await store.getExact("task:prose-resume")).outcome).toBe(PROSE_PAUSE);
    const spy = spies();
    const resumed = await quietly(() =>
      handleDoCommand(
        resumeArgs("task:prose-resume", answersPath, repositoryPath, ["--json"]),
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(spy.checks).not.toHaveBeenCalled();
    expect(spy.resume.mock.calls[0]![0].freshAuthority.check).toBe(false);
    const decoded = decodeDelegatedTaskResult(JSON.parse(resumed.stdout));
    expect(decoded.requirements.filter((requirement) => requirement.kind === "check")).toEqual([]);
  });

  it("row 7 control: resume with one --check runs it and grants check", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const { answersPath } = await pauseTask(
      repositoryPath,
      stateDirectory,
      "task:flag-resume",
      PROSE_PAUSE,
    );
    const spy = spies();
    const resumed = await quietly(() =>
      handleDoCommand(
        resumeArgs("task:flag-resume", answersPath, repositoryPath, [
          "--check",
          "docs:check",
          "--json",
        ]),
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(spy.resume.mock.calls[0]![0].freshAuthority.check).toBe(true);
    expect(ranChecks(spy)).toEqual([
      [{ checkId: "npm-run-docs:check", argv: ["npm", "run", "docs:check"] }],
    ]);
    const decoded = decodeDelegatedTaskResult(JSON.parse(resumed.stdout));
    expect(decoded.checkState).toBe("passed");
    expect(decoded.fulfillment).toBe("complete");
  });

  it("row 10: a fresh-run check survives the pause and resume refuses when it is not re-passed", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const { answersPath, pauseSpy } = await pauseTask(
      repositoryPath,
      stateDirectory,
      "task:carried-check",
      "Document docs/x.md.",
      ["--check", "docs:check"],
    );
    expect(pauseRequirements(pauseSpy)).toEqual([
      "R1:artifact:docs/x.md",
      "C1:check:npm-run-docs:check",
    ]);
    expect(currentAuthority(pauseSpy).check).toBe(true);
    const store = new DelegatedTaskStateStore({
      directory: join(stateDirectory, "delegated-tasks"),
    });
    const retained = await store.getExact("task:carried-check");
    expect(
      retained.originalRequirements.map((requirement) => [
        requirement.kind,
        requirement.targetLocator,
      ]),
    ).toEqual([
      ["check", "npm-run-docs:check"],
      ["artifact", "docs/x.md"],
    ]);

    const spy = spies();
    const error = await refusal(
      handleDoCommand(
        resumeArgs("task:carried-check", answersPath, repositoryPath, ["--json"]),
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(error.reason).toBe("resume-check-not-resupplied");
    expect(error.missingChecks).toEqual(["docs:check"]);
    expect(spy.resume).not.toHaveBeenCalled();
    expect(spy.runDelegatedTask).not.toHaveBeenCalled();
    expect(spy.checks).not.toHaveBeenCalled();
    expect((await store.getExact("task:carried-check")).phase).toBe("pending-input");

    // Re-passing a different check does not stand in for the retained one.
    const otherSpy = spies();
    const otherError = await refusal(
      handleDoCommand(
        resumeArgs("task:carried-check", answersPath, repositoryPath, ["--check", "test"]),
        options(repositoryPath, stateDirectory, otherSpy),
      ),
    );
    expect(otherError.missingChecks).toEqual(["docs:check"]);
    expect(otherSpy.resume).not.toHaveBeenCalled();

    const controlSpy = spies();
    const resumed = await quietly(() =>
      handleDoCommand(
        resumeArgs("task:carried-check", answersPath, repositoryPath, [
          "--check",
          "docs:check",
          "--json",
        ]),
        options(repositoryPath, stateDirectory, controlSpy),
      ),
    );
    expect(ranChecks(controlSpy)).toEqual([
      [{ checkId: "npm-run-docs:check", argv: ["npm", "run", "docs:check"] }],
    ]);
    const decoded = decodeDelegatedTaskResult(JSON.parse(resumed.stdout));
    expect(decoded.checkState).toBe("passed");
    expect(decoded.fulfillment).toBe("complete");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("row 10: an undeclared resume check refuses before the retained task is touched", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const { answersPath } = await pauseTask(
      repositoryPath,
      stateDirectory,
      "task:resume-undeclared",
      "Document docs/x.md.",
    );
    const spy = spies();
    const error = await refusal(
      handleDoCommand(
        resumeArgs("task:resume-undeclared", answersPath, repositoryPath, ["--check", "nope"]),
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(error.reason).toBe("undeclared-script");
    expect(spy.authority).not.toHaveBeenCalled();
    expect(spy.resume).not.toHaveBeenCalled();
  });
});

describe("delegated resume names a retained check this CLI did not mint by its id", () => {
  it("row 10 scope: a retained check id without the npm-run prefix is reported verbatim", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const requirements = [
      createDelegatedRequirement("R1", "artifact", "docs/x.md"),
      createDelegatedRequirement("C1", "check", "npm-test"),
    ];
    const paused = await inspectPauseDelegatedTask({
      taskId: "task:foreign-check",
      ownerId: "cli-operator",
      outcome: "Document docs/x.md.",
      request: createDelegatedRequest(requirements, "Document docs/x.md."),
      repositoryPath,
      repositoryRevision: REVISION,
      admittedLocators: [],
      materialTargetLocator: "docs/x.md",
      originalRequirements: requirements,
      inputMode: "no-input",
      currentAuthority: { read: true, write: false, check: true },
      storeDirectory: join(stateDirectory, "delegated-tasks"),
      now: NOW,
    });
    expect(paused.status).toBe("needs-input");
    const answersPath = join(stateDirectory, "foreign.json");
    await writeFile(answersPath, '{"q-target":"docs/api.md"}', "utf8");
    const spy = spies();
    const error = await refusal(
      handleDoCommand(
        resumeArgs("task:foreign-check", answersPath, repositoryPath, ["--check", "test"]),
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(error.reason).toBe("resume-check-not-resupplied");
    expect(error.missingChecks).toEqual(["npm-test"]);
    expect(spy.resume).not.toHaveBeenCalled();
  });
});

describe("delegated pause targets come from path tokens, not fixture phrases", () => {
  it("row 8: 'the operators directory' names no target and raises no target question", async () => {
    const { repositoryPath, stateDirectory } = await fixture(null);
    const spy = spies();
    const printed = await quietly(() =>
      handleDoCommand(
        ["--delegate", "Document the operators directory.", "--repo", repositoryPath, "--json"],
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    const input = spy.inspectPause.mock.calls[0]![0];
    expect(input.materialTargetLocator).toBeUndefined();
    expect(input.admittedLocators).toEqual([]);
    const decoded = decodeDelegatedTaskResult(JSON.parse(printed.stdout));
    expect(decoded.pendingQuestionIds).toEqual([]);
    expect(decoded.stopReason).not.toBe("needs-input");
  });

  it("row 8 control: a named missing path still pauses with the target question", async () => {
    const { repositoryPath, stateDirectory } = await fixture(null);
    const spy = spies();
    const printed = await quietly(() =>
      handleDoCommand(
        ["--delegate", "Document docs/operators/index.md.", "--repo", repositoryPath, "--json"],
        options(repositoryPath, stateDirectory, spy),
      ),
    );
    expect(spy.inspectPause.mock.calls[0]![0].materialTargetLocator).toBe(
      "docs/operators/index.md",
    );
    const decoded = decodeDelegatedTaskResult(JSON.parse(printed.stdout));
    expect(decoded.pendingQuestionIds).toEqual(["q-target"]);
  });
});
