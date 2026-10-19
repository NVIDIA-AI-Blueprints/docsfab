// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildRequest,
  journeyVerdictFailure,
  journeyWorkflow,
  main,
  resolveJourneyExecutionProfile,
  runLiveJourneys,
  type LiveJourneyInput,
  type LiveJourneyResult,
} from "../scripts/live-journey-gate.mts";
import {
  LIVE_MODEL_CI_COMPOSITION_ID,
  prepareLiveModelCiConfig,
} from "../scripts/prepare-live-model-ci-config.js";
import { executionProfileIdentity } from "../src/config/execution-profile.js";
import { limit } from "../src/config/limits.js";
import { resolveSecretsEnvPath } from "../src/config/split-layout.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const execute = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");
const script = join(packageRoot, "scripts/live-journey-gate.mts");
const temporaryRoots: string[] = [];

/**
 * Per-case allowance for the cases that spawn the gate: each starts a fresh Node
 * process and compiles the script through tsx. `testTimeoutMs` keeps CI at or
 * above `test.ciTimeoutMs`.
 */
const SPAWN_TIMEOUT_MS = testTimeoutMs(120_000);

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the gate with no credential, so it stops at its first refusal without
 * reaching a provider. The refusal message proves `main` ran; an entry-point
 * guard that never matched would exit 0 and print nothing.
 */
async function runGate(
  entry: string,
  repository: string = packageRoot,
  credential = "",
): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      ["--import", "tsx", entry, "--repo", repository],
      { cwd: packageRoot, env: { ...process.env, MODEL_API_KEY: credential } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * A clean git repository with two tracked documentation pages, which is all
 * the gate reads from a workspace: the revision, the clean manifest, and the
 * corpus denominator.
 */
function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "docsfab-live-journey-tree-"));
  temporaryRoots.push(root);
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "gate@example.test");
  git("config", "user.name", "gate");
  writeFileSync(join(root, "README.md"), "# fixture\n\nWhat this page is for.\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/index.md"), "# docs\n\nA second tracked page.\n");
  writeFileSync(join(root, "notes.txt"), "not a documentation page\n");
  git("add", "-A");
  git("commit", "-m", "fixture");
  return root;
}

/**
 * The installed composition binding, prepared the way CI prepares one, with a
 * configuration root plus MODEL_* variables, and torn down afterwards. The base
 * URL and model are the CI composition's own because the resolver matches on
 * (providerId, baseUrl, modelId); cases supply the harness seam, so no request
 * is made.
 */
function withJourneyEnvironment(): () => void {
  const workspace = mkdtempSync(join(tmpdir(), "docsfab-live-journey-config-"));
  temporaryRoots.push(workspace);
  const configurationRoot = join(workspace, "config");
  mkdirSync(configurationRoot, { recursive: true });
  chmodSync(configurationRoot, 0o700);
  writeFileSync(
    join(configurationRoot, ".env"),
    readFileSync(join(packageRoot, ".env.example"), "utf8"),
  );
  const previous = new Map<string, string | undefined>();
  const set = (key: string, value: string): void => {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  };
  set("DOCSFAB_CONFIG_ROOT", configurationRoot);
  set("MODEL_PROVIDER", "nvidia-inference-api");
  set("MODEL_BASE_URL", HUB_BASE_URL);
  set("MODEL_ID", "azure/openai/gpt-6-sol");
  set("MODEL_API_KEY", "not-a-real-credential");
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const CI_PREPARED_CREDENTIAL = "ci-prepared-not-a-real-credential";

/**
 * The configuration root exactly as CI's configuration preparation writes it:
 * host.yaml naming the live composition, and secrets.env holding
 * MODEL_API_KEY unless `secrets` is false. runtime-run.sh exports neither the
 * key nor any MODEL_* value to the gate, so both leave the environment here.
 * The returned function restores the environment.
 */
async function withCiPreparedLayout(options: { secrets: boolean }): Promise<() => void> {
  const snapshot = { ...process.env };
  const workspace = mkdtempSync(join(tmpdir(), "docsfab-live-journey-ci-layout-"));
  temporaryRoots.push(workspace);
  const configurationRoot = join(workspace, "config");
  // Clear first, as CI's allowlist does, so preparation cannot copy an ambient
  // provider key into the temporary secrets.env.
  for (const name of Object.keys(process.env)) {
    if (/^(?:MODEL|JUDGE)_|_API_KEY$|^DOCSFAB_ACTIVE_/u.test(name)) delete process.env[name];
  }
  await prepareLiveModelCiConfig({ configurationRoot, modelApiKey: CI_PREPARED_CREDENTIAL });
  if (!options.secrets) rmSync(resolveSecretsEnvPath(configurationRoot));
  process.env.DOCSFAB_CONFIG_ROOT = configurationRoot;
  return () => {
    for (const name of Object.keys(process.env)) {
      if (!Object.hasOwn(snapshot, name)) delete process.env[name];
    }
    Object.assign(process.env, snapshot);
  };
}

function gateArguments(repository: string, workspace: string): string[] {
  return [
    "--repo",
    repository,
    "--review-target",
    "README.md",
    "--ask-target",
    "README.md",
    "--question",
    "What does this page say the project is for?",
    "--state",
    join(workspace, "state"),
    "--out",
    join(workspace, "out"),
    "--label",
    "unit",
  ];
}

/** Answers every step with one inert summary, so no provider is reached. */
const SCRIPTED_HARNESS: AgentHarness = {
  runStep: async () => ({ summary: "scripted" }),
};

function journeyInput(repository: string, workspace: string): LiveJourneyInput {
  return {
    repository,
    revision: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    reviewTargets: ["README.md"],
    askTarget: "README.md",
    question: "What does this page say the project is for?",
    stateDirectory: join(workspace, "state"),
    credential: "not-a-real-credential",
    label: "unit",
  };
}

function result(journey: "review" | "ask", status: string): LiveJourneyResult {
  return {
    journey,
    workflow: journey === "ask" ? "live-agent-turn" : "review-documentation",
    runId: `run-unit-${journey}`,
    status,
    durationMs: 1,
    steps: [],
    recordSha256: "",
  };
}

describe("live-journey gate entry point (#1046)", () => {
  it("runs its main when invoked by its real path", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const result = await runGate(script);
    expect(result.stderr).toContain(
      "live-journey-gate: MODEL_API_KEY was not supplied by the CI credential.",
    );
    expect(result.code).not.toBe(0);
  });

  it("runs its main when invoked through a symlink", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    // `process.argv[1]` is the symlink and `import.meta.url` is the target, so
    // an un-realpathed comparison never matches and the gate exits 0 having
    // asserted nothing. An installed or packaged DocsFab is invoked this way.
    const root = mkdtempSync(join(tmpdir(), "docsfab-live-journey-link-"));
    temporaryRoots.push(root);
    const link = join(root, "live-journey-gate.mts");
    symlinkSync(script, link);
    const result = await runGate(link);
    expect(result.stderr).toContain(
      "live-journey-gate: MODEL_API_KEY was not supplied by the CI credential.",
    );
    expect(result.code).not.toBe(0);
  });

  it("refuses a dirty review workspace before spending provider time", {
    timeout: SPAWN_TIMEOUT_MS,
  }, async () => {
    // The hosted runner re-derives the workspace manifest and throws "no longer
    // matches its exact clean manifest" only after the model work is paid for.
    const root = mkdtempSync(join(tmpdir(), "docsfab-live-journey-repo-"));
    temporaryRoots.push(root);
    const git = (...args: string[]): void => {
      execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    };
    git("init", "--initial-branch=main");
    git("config", "user.email", "gate@example.test");
    git("config", "user.name", "gate");
    writeFileSync(join(root, "README.md"), "# fixture\n");
    git("add", "README.md");
    git("commit", "-m", "fixture");

    // Positive control: a clean checkout passes this gate and stops at the next
    // refusal.
    const clean = await runGate(script, root, "a-real-looking-credential");
    expect(clean.stderr).toContain("live-journey-gate: --out is required.");

    writeFileSync(join(root, "README.md"), "# fixture, edited\n");
    const dirty = await runGate(script, root, "a-real-looking-credential");
    expect(dirty.stderr).toContain("live-journey-gate: the review workspace is not clean;");
    expect(dirty.code).not.toBe(0);
  });

  it("refuses a missing required argument by name", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    // With a credential present the next refusal is the argument.
    try {
      await execute(process.execPath, ["--import", "tsx", script], {
        cwd: packageRoot,
        env: { ...process.env, MODEL_API_KEY: "not-a-real-credential" },
      });
      throw new Error("expected the gate to refuse a missing --repo");
    } catch (error) {
      const failure = error as { stderr?: string; code?: number };
      expect(failure.stderr).toContain("live-journey-gate: --repo is required.");
      expect(failure.code).not.toBe(0);
    }
  });
});

describe("live-journey gate verdict (#1046)", () => {
  // The spawn cases stop at a refusal before any journey runs, so the verdict
  // is tested here as a value.
  it("says nothing when both journeys settled succeeded", () => {
    expect(journeyVerdictFailure([result("ask", "succeeded"), result("review", "succeeded")])).toBe(
      undefined,
    );
  });

  it("names the journey that did not settle succeeded", () => {
    expect(journeyVerdictFailure([result("ask", "succeeded"), result("review", "failed")])).toBe(
      "live-journey-gate: review=failed",
    );
  });

  it("treats a refusal before any record as a failure, not as silence", () => {
    // A guard that refuses the projection produces no record, and the gate
    // must not read a missing record as a journey that went fine.
    expect(
      journeyVerdictFailure([
        result("ask", "refused-before-record"),
        result("review", "succeeded"),
      ]),
    ).toBe("live-journey-gate: ask=refused-before-record");
  });

  it("names every failing journey, in run order", () => {
    expect(
      journeyVerdictFailure([result("ask", "refused-before-record"), result("review", "failed")]),
    ).toBe("live-journey-gate: ask=refused-before-record, review=failed");
  });
});

describe("live-journey gate request shapes (#1046)", () => {
  it("builds a dispatchable review request with a counted corpus", async () => {
    // `git ls-tree` does no wildcard pathspec matching, so a `*.md` pathspec
    // counts 0 pages and `parseHostRuntimeRequest` refuses the scope
    // (corpusFileCount must be positive).
    const repository = fixtureRepository();
    const workspace = mkdtempSync(join(tmpdir(), "docsfab-live-journey-build-"));
    temporaryRoots.push(workspace);
    const input = journeyInput(repository, workspace);
    // The capsule is minted relative to now because the request contract
    // refuses an already-expired capsule; the assertion pins the arithmetic.
    const startedAt = Date.now();
    const restore = withJourneyEnvironment();
    const request = await resolveJourneyExecutionProfile(journeyWorkflow("review"))
      .then((profile) => buildRequest(input, "review", profile, startedAt))
      .finally(restore);
    expect(request.workflow).toBe("review-documentation");
    expect(request.packet.reviewScope?.corpusFileCount).toBe(2);
    expect(request.stepIds[0]).toBe("audit-documentation");
    expect(request.stepIds.length).toBeGreaterThan(1);
    expect(request.packet.reviewEvent?.content).toContain("README.md");
    expect(request.capsule.expiresAt).toBe(
      new Date(startedAt + limit("ci.liveJourney.jobTimeoutMs").value).toISOString(),
    );
    // The sealed composition id is the one CI prepares its configuration root
    // for, and the resolved profile is that composition's model, so one lane is
    // not sealed over another's profile.
    expect(request.composition.compositionId).toBe(LIVE_MODEL_CI_COMPOSITION_ID);
    expect(request.composition.executionProfile?.modelId).toBe(
      executionProfileIdentity(LIVE_MODEL_CI_COMPOSITION_ID).modelId,
    );
  });

  it("builds the ask request from the same input, with the turn envelope", async () => {
    // The same input produces a different workflow, step list and packet for
    // the other journey.
    const repository = fixtureRepository();
    const workspace = mkdtempSync(join(tmpdir(), "docsfab-live-journey-build-ask-"));
    temporaryRoots.push(workspace);
    const input = journeyInput(repository, workspace);
    const restore = withJourneyEnvironment();
    const request = await resolveJourneyExecutionProfile(journeyWorkflow("ask"))
      .then((profile) => buildRequest(input, "ask", profile, Date.now()))
      .finally(restore);
    expect(request.workflow).toBe("live-agent-turn");
    expect(request.packet.reviewEvent?.content).toContain("docsfab-live-agent-turn");
    expect(request.packet.reviewScope?.corpusFileCount).toBe(2);
  });
});

describe("live-journey gate run (#1046)", () => {
  it("exits non-zero, with evidence, when a journey does not settle succeeded", {
    timeout: SPAWN_TIMEOUT_MS,
  }, async () => {
    // Both journeys go through `runHostedWorkflow`, with its in-process
    // acceptance seam standing in for the provider. The ask settles `succeeded`
    // and the review does not, so the verdict names exactly one journey and the
    // artifact carries both records.
    const repository = fixtureRepository();
    const workspace = mkdtempSync(join(tmpdir(), "docsfab-live-journey-run-"));
    temporaryRoots.push(workspace);
    const restore = withJourneyEnvironment();
    try {
      await expect(
        main(
          [
            "--repo",
            repository,
            "--review-target",
            "README.md",
            "--ask-target",
            "README.md",
            "--question",
            "What does this page say the project is for?",
            "--state",
            join(workspace, "state"),
            "--out",
            join(workspace, "out"),
            "--label",
            "unit",
          ],
          { executionHarness: SCRIPTED_HARNESS },
        ),
      ).rejects.toThrow("live-journey-gate: review=failed");
      const evidence = JSON.parse(
        readFileSync(join(workspace, "out", "live-journey-gate.json"), "utf8"),
      ) as { revision: string; results: LiveJourneyResult[] };
      expect(evidence.revision).toBe(
        execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      );
      expect(evidence.results.map((entry) => entry.journey)).toEqual(["ask", "review"]);
      expect(evidence.results[0]?.status).toBe("succeeded");
      expect(evidence.results[1]?.status).not.toBe("succeeded");
      expect(evidence.results[1]?.steps[0]).toEqual({
        id: "audit-documentation",
        status: "succeeded",
      });
    } finally {
      restore();
    }
  });

  it("hands over each journey as it settles, so a stopped job still leaves evidence", {
    timeout: SPAWN_TIMEOUT_MS,
  }, async () => {
    // The job ceiling is a platform stop, not a catchable error, so evidence is
    // written as each journey settles; a job stopped during the second journey
    // keeps the first journey's record.
    const repository = fixtureRepository();
    const workspace = mkdtempSync(join(tmpdir(), "docsfab-live-journey-settle-"));
    temporaryRoots.push(workspace);
    const restore = withJourneyEnvironment();
    const handovers: string[][] = [];
    try {
      const results = await runLiveJourneys(journeyInput(repository, workspace), {
        executionHarness: SCRIPTED_HARNESS,
        onJourneySettled: (settled) => {
          handovers.push(settled.map((entry) => entry.journey));
        },
      });
      expect(handovers).toEqual([["ask"], ["ask", "review"]]);
      expect(results.map((entry) => entry.journey)).toEqual(["ask", "review"]);
    } finally {
      restore();
    }
  });

  it("reads the credential CI prepared in the configuration root, not only the environment", {
    timeout: SPAWN_TIMEOUT_MS,
  }, async () => {
    // CI hands the key to the gate only through the prepared secrets.env.
    const repository = fixtureRepository();
    const workspace = mkdtempSync(join(tmpdir(), "docsfab-live-journey-ci-run-"));
    temporaryRoots.push(workspace);
    const restore = await withCiPreparedLayout({ secrets: true });
    try {
      expect(process.env.MODEL_API_KEY).toBeUndefined();
      // The scripted ask settles succeeded and the scripted review does not, so
      // this verdict means both journeys ran past the credential check.
      await expect(
        main(gateArguments(repository, workspace), { executionHarness: SCRIPTED_HARNESS }),
      ).rejects.toThrow("live-journey-gate: review=failed");
      const evidence = JSON.parse(
        readFileSync(join(workspace, "out", "live-journey-gate.json"), "utf8"),
      ) as { results: LiveJourneyResult[] };
      expect(evidence.results.map((entry) => [entry.journey, entry.status])).toEqual([
        ["ask", "succeeded"],
        ["review", "failed"],
      ]);
      expect(process.env.MODEL_API_KEY).toBe(CI_PREPARED_CREDENTIAL);
    } finally {
      restore();
    }
  });

  it("still refuses when neither the environment nor the configuration root has the credential", {
    timeout: SPAWN_TIMEOUT_MS,
  }, async () => {
    const repository = fixtureRepository();
    const workspace = mkdtempSync(join(tmpdir(), "docsfab-live-journey-ci-refuse-"));
    temporaryRoots.push(workspace);
    const restore = await withCiPreparedLayout({ secrets: false });
    try {
      await expect(
        main(gateArguments(repository, workspace), { executionHarness: SCRIPTED_HARNESS }),
      ).rejects.toThrow("live-journey-gate: MODEL_API_KEY was not supplied by the CI credential.");
      // The refusal comes before any journey runs or any evidence is written.
      expect(existsSync(join(workspace, "out"))).toBe(false);
      expect(existsSync(join(workspace, "state"))).toBe(false);
    } finally {
      restore();
    }
  });
});
