// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import { parseDotenvAssignments, parseDotenvLine } from "../src/config/dotenv.js";
import { loadEffectiveLimitEnvironment, resolveLimits } from "../src/config/limits.js";
import { SECRET_ENV_KEYS } from "../src/config/profile-projection.js";
import {
  loadEnvFileIntoEnvironment,
  resolveSecretsEnvLockLimits,
  SECRETS_ENV_FILE,
  SECRETS_ENV_LOCK_FILE,
  writeSecretsEnvFile,
} from "../src/config/split-layout.js";
import { ensureLiveAgentConfiguration } from "../src/live-agent/host.js";
import { runSetupBootstrap } from "../src/setup/bootstrap.js";
import { INTERNAL_SETUP_EXECUTION_PROFILE } from "../src/setup/dogfood-profile.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

// Synthetic, test-only credential values, not real keys.
const STORED_KEY = "sk-issue-1117-stored-fixture";
const OTHER_KEY = "sk-issue-1117-other-fixture";
const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(39);
const DOUBLE_QUOTE = String.fromCharCode(34);

/**
 * Historical GPT-5.4 operator attestation a legacy `.env` host carries. Inlined
 * because the setup module no longer exports GPT-5.x attestations (#1512).
 */
const GPT_54_OPERATOR_ATTESTATION_LINES = [
  "MODEL_PROFILE_APPROVED_SOURCE=https://inference-backend.example.com/api/v1/models?search=gpt-5.4",
  "MODEL_PROFILE_EFFECTIVE_DATE=2026-08-04",
  "MODEL_PROFILE_REVIEW_AFTER=2026-12-31",
] as const;

const temporary = temporaryRoots();

/** Every fixture root is a disposable directory under the OS temporary directory. */
async function temporaryConfigurationRoot(prefix: string): Promise<string> {
  const root = await temporary.create(prefix);
  expect(root.startsWith(tmpdir())).toBe(true);
  return root;
}

/** Materialize a split layout with a stored credential through explicit setup. */
async function configuredSplitRoot(prefix: string): Promise<string> {
  const root = await temporaryConfigurationRoot(prefix);
  const result = await runSetupBootstrap({
    profile: INTERNAL_SETUP_EXECUTION_PROFILE,
    environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: STORED_KEY },
  });
  expect(result.layout).toBe("split");
  expect(result.status).toBe("ready");
  expect(await readFile(join(root, SECRETS_ENV_FILE), "utf8")).toContain(
    `MODEL_API_KEY=${STORED_KEY}`,
  );
  return root;
}

function terminalStreams() {
  return {
    input: Object.assign(new PassThrough(), { isTTY: true }),
    output: Object.assign(new PassThrough(), { isTTY: true }),
  };
}

function assignmentLines(source: string): string[] {
  return source.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
}

/** A well-formed secrets file: every line is one KEY=value, and no key repeats. */
function expectWellFormedSecrets(source: string): void {
  const lines = assignmentLines(source);
  const keys = lines.map((line) => line.slice(0, line.indexOf("=")));
  for (const line of lines) expect(line).toMatch(/^[A-Z][A-Z0-9_]*=/u);
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of SECRET_ENV_KEYS) expect(keys).toContain(key);
}

function secretsLockOverrideEnvironment(
  assignments: Partial<
    Record<"secrets.lockWaitMs" | "secrets.lockStaleMs" | "secrets.lockRetryMs", number>
  >,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(assignments)) {
    const key = limitDefinition(name).override;
    if (!key) {
      throw new Error(`missing host override key for ${name}`);
    }
    environment[key] = String(value);
  }
  return environment;
}

async function fileIdentity(path: string): Promise<{ bytes: string; mtimeMs: number }> {
  const [bytes, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  return { bytes, mtimeMs: metadata.mtimeMs };
}

async function pause(milliseconds = 20): Promise<void> {
  // Let any later write land on a distinguishable modification time.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** How long a case waits for a writer process to create a marker file. */
const WRITER_MARKER_WAIT_MS = 20_000;

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + WRITER_MARKER_WAIT_MS;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await pause(10);
    }
  }
}

// Local budget of the case that holds a writer (testTimeoutMs() scales it up
// in CI), and the held writer's wait for its release file, nested inside it
// through nestedDeadlineMs(). The release wait has to outlast what the case
// does before it writes the release file (writer B's start, bounded by
// WRITER_MARKER_WAIT_MS, a 500 ms pause and two reads) and still end before
// the case does, so the writer's own message lands first.
const WRITER_HOLD_CASE_LOCAL_MS = 60_000;
const WRITER_RELEASE_LOCAL_MS = 35_000;
const WRITER_RELEASE_TIMEOUT_MS = nestedDeadlineMs(
  WRITER_RELEASE_LOCAL_MS,
  WRITER_HOLD_CASE_LOCAL_MS,
);

/**
 * One secrets writer in its own process. It writes the ready marker just
 * before writing; with a hold marker it stops between the flushed temporary
 * file and the rename until the release file exists, or fails once its
 * release budget runs out. Without that budget, a case that failed before it
 * wrote the release file left the writer polling forever.
 */
const WRITER_SOURCE = [
  'import { access, writeFile } from "node:fs/promises";',
  'import { writeSecretsEnvFile } from "./src/config/split-layout.ts";',
  "const [root, key, value, ready, hold, release, releaseTimeoutMs] = process.argv.slice(1);",
  "const released = async () => {",
  "  const deadline = Date.now() + Number(releaseTimeoutMs);",
  "  for (;;) {",
  "    try { await access(release); return; }",
  "    catch {",
  "      if (Date.now() > deadline)",
  "        throw new Error(`timed out after ${releaseTimeoutMs}ms waiting for ${release}`);",
  "      await new Promise((done) => setTimeout(done, 10));",
  "    }",
  "  }",
  "};",
  "await writeFile(ready, String(process.pid));",
  "await writeSecretsEnvFile(root, [[key, value]], hold",
  "  ? { async onTemporaryWritten() { await writeFile(hold, String(process.pid)); await released(); } }",
  "  : {});",
].join("\n");

/** Every writer process runWriter spawned; the afterEach below stops them. */
const writerChildren: ReturnType<typeof spawn>[] = [];

function runWriter(
  args: readonly [
    root: string,
    key: string,
    value: string,
    ready: string,
    hold?: string,
    release?: string,
  ],
  releaseTimeoutMs = WRITER_RELEASE_TIMEOUT_MS,
): Promise<{ code: number | null; stderr: string }> {
  const [root, key, value, ready, hold = "", release = ""] = args;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        WRITER_SOURCE,
        root,
        key,
        value,
        ready,
        hold,
        release,
        String(releaseTimeoutMs),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    writerChildren.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stderr }));
  });
}

/** A process id that has already exited on this host. */
function exitedProcessId(): Promise<number> {
  return new Promise((resolvePid, rejectPid) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("error", rejectPid);
    child.once("close", () => resolvePid(child.pid!));
  });
}

// Stops any writer a case left running, whatever the outcome, including a case
// that timed out before its own cleanup ran.
afterEach(async () => {
  const active = writerChildren.splice(0);
  for (const child of active) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    active.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    }),
  );
});

describe("secrets.env writes (issue 1117)", () => {
  it("keeps the stored credential intact when setup runs many times in parallel on one root", async () => {
    const root = await configuredSplitRoot("docsfab-1117-parallel-setup-");
    const secretsPath = join(root, SECRETS_ENV_FILE);

    const statuses = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          runSetupBootstrap({ environment: { DOCSFAB_CONFIG_ROOT: root } }),
        ),
      );
      for (const result of results) statuses.add(result.status);
    }

    // No concurrent reader ever observed a missing or truncated credential.
    expect([...statuses]).toEqual(["ready"]);
    const source = await readFile(secretsPath, "utf8");
    expect(source).toContain(`MODEL_API_KEY=${STORED_KEY}`);
    expectWellFormedSecrets(source);
    expect((await stat(secretsPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).not.toContain(SECRETS_ENV_LOCK_FILE);
  });

  it("keeps the stored credential intact when live-agent configuration runs many times in parallel", async () => {
    const root = await configuredSplitRoot("docsfab-1117-parallel-live-");
    const secretsPath = join(root, SECRETS_ENV_FILE);

    for (let round = 0; round < 3; round += 1) {
      await Promise.all(
        Array.from({ length: 12 }, () =>
          ensureLiveAgentConfiguration({
            environment: { DOCSFAB_CONFIG_ROOT: root },
            ...terminalStreams(),
          }),
        ),
      );
    }

    const source = await readFile(secretsPath, "utf8");
    expect(source).toContain(`MODEL_API_KEY=${STORED_KEY}`);
    expectWellFormedSecrets(source);
  });

  it("does not write secrets.env during live-agent startup", async () => {
    const root = await configuredSplitRoot("docsfab-1117-live-no-write-");
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const before = await fileIdentity(secretsPath);
    await pause();

    const streams = terminalStreams();
    let rendered = "";
    streams.output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    const config = await ensureLiveAgentConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
      ...streams,
    });
    // An ambient credential that differs from the stored one is not persisted.
    await ensureLiveAgentConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: OTHER_KEY },
      ...terminalStreams(),
    });

    expect(config.model.apiKey).toBe(STORED_KEY);
    expect(await fileIdentity(secretsPath)).toEqual(before);
    // The operator can tell which configuration root and secrets file are in effect.
    expect(rendered).toContain(`Configuration: ${root}`);
    expect(rendered).toContain(secretsPath);
    expect(rendered).not.toContain(STORED_KEY);
  });

  it("asks for a provider and writes nothing when live-agent starts on a fresh root with an exported key", async () => {
    const root = await temporaryConfigurationRoot("docsfab-1117-live-fresh-");
    const questions: string[] = [];
    const stop = async (label: string): Promise<string> => {
      questions.push(label);
      throw new Error(`guided setup continued to ${label}`);
    };

    await expect(
      ensureLiveAgentConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: OTHER_KEY },
        ...terminalStreams(),
        prompter: { readChoice: stop, readValue: stop, readSecret: stop },
      }),
    ).rejects.toThrow("guided setup continued to Provider");

    // An exported key does not choose a model, so nothing offers to save it.
    expect(questions).toEqual(["Provider"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("still refuses a missing credential at noninteractive live-agent startup without writing", async () => {
    const root = await temporaryConfigurationRoot("docsfab-1117-live-refuse-");

    await expect(
      ensureLiveAgentConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root },
        input: Object.assign(new PassThrough(), { isTTY: false }),
        output: Object.assign(new PassThrough(), { isTTY: false }),
      }),
    ).rejects.toThrow(
      /could not use the current model configuration.*Next action: docsfab setup/su,
    );
    expect(await readdir(root)).not.toContain(SECRETS_ENV_FILE);
  });

  it("leaves a legacy .env configuration root untouched across parallel startup checks", async () => {
    const root = await temporaryConfigurationRoot("docsfab-1117-legacy-");
    const envPath = join(root, ".env");
    await writeFile(
      envPath,
      [
        "MODEL_PROVIDER=nvidia-inference-api",
        `MODEL_BASE_URL=${HUB_BASE_URL}`,
        "MODEL_ID=azure/openai/gpt-5.4",
        "MODEL_API_FORMAT=chat_completions",
        `MODEL_API_KEY=${STORED_KEY}`,
        "MODEL_CONTEXT_WINDOW=1000000",
        "MODEL_MAX_INPUT_TOKENS=1000000",
        "MODEL_MAX_OUTPUT_TOKENS=128000",
        "MODEL_API_MIN_OUTPUT_TOKENS=16",
        "MODEL_CONTEXT_RESERVE_TOKENS=4096",
        "MODEL_REASONING=true",
        "MODEL_INPUT_TYPES=text",
        "MODEL_SUPPORTS_DEVELOPER_ROLE=false",
        "MODEL_SUPPORTS_REASONING_EFFORT=false",
        "MODEL_COMPATIBLE_API_FORMATS=chat_completions",
        "MODEL_INPUT_COST_PER_MILLION=unknown",
        "MODEL_OUTPUT_COST_PER_MILLION=unknown",
        "MODEL_CACHE_READ_COST_PER_MILLION=unknown",
        "MODEL_CACHE_WRITE_COST_PER_MILLION=unknown",
        ...GPT_54_OPERATOR_ATTESTATION_LINES,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const before = await fileIdentity(envPath);
    await pause();

    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, () =>
        runSetupBootstrap({ environment: { DOCSFAB_CONFIG_ROOT: root } }),
      ),
      ...Array.from({ length: 6 }, () =>
        ensureLiveAgentConfiguration({
          environment: { DOCSFAB_CONFIG_ROOT: root },
          ...terminalStreams(),
        }),
      ),
    ]);

    expect(
      results.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : [])),
    ).toEqual([]);
    expect(await fileIdentity(envPath)).toEqual(before);
    expect(await readdir(root)).not.toContain(SECRETS_ENV_FILE);
  });

  it("does not rewrite secrets.env when the merged content is unchanged", async () => {
    const root = await configuredSplitRoot("docsfab-1117-noop-");
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const before = await fileIdentity(secretsPath);
    await pause();

    const outcome = await runSetupBootstrap({
      environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: STORED_KEY },
    });

    expect(outcome.status).toBe("ready");
    expect(await fileIdentity(secretsPath)).toEqual(before);
  });

  it("never blanks a stored value through a merge, while an explicit clear still works", async () => {
    const root = await configuredSplitRoot("docsfab-1117-blank-");
    const secretsPath = join(root, SECRETS_ENV_FILE);

    // An all-empty template must not blank the operator secrets file.
    await writeSecretsEnvFile(
      root,
      SECRET_ENV_KEYS.map((key) => [key, ""] as const),
    );
    expect(await readFile(secretsPath, "utf8")).toContain(`MODEL_API_KEY=${STORED_KEY}`);

    // A new non-empty value still replaces the stored one.
    await writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]]);
    const replaced = await readFile(secretsPath, "utf8");
    expect(replaced).toContain(`MODEL_API_KEY=${OTHER_KEY}`);
    expectWellFormedSecrets(replaced);

    await writeSecretsEnvFile(root, [["MODEL_API_KEY", ""]], { clear: ["MODEL_API_KEY"] });
    const cleared = await readFile(secretsPath, "utf8");
    expect(cleared).not.toContain(OTHER_KEY);
    expect(assignmentLines(cleared)).toContain("MODEL_API_KEY=");
    expectWellFormedSecrets(cleared);
  });

  it("writes through a same-directory 0600 temporary file and never leaves a truncated target", async () => {
    const root = await configuredSplitRoot("docsfab-1117-atomic-");
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const before = await readFile(secretsPath, "utf8");
    const observed: Array<{ entries: string[]; temporary: string; mode: number; target: string }> =
      [];

    await expect(
      writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]], {
        async onTemporaryWritten(temporaryPath) {
          observed.push({
            entries: await readdir(root),
            temporary: await readFile(temporaryPath, "utf8"),
            mode: (await stat(temporaryPath)).mode & 0o777,
            target: await readFile(secretsPath, "utf8"),
          });
          throw new Error("simulated interruption before rename");
        },
      }),
    ).rejects.toThrow("simulated interruption before rename");

    expect(observed).toHaveLength(1);
    const [midWrite] = observed;
    expect(midWrite!.mode).toBe(0o600);
    expect(midWrite!.temporary).toContain(`MODEL_API_KEY=${OTHER_KEY}`);
    // The target was still the complete previous file while the temp file existed.
    expect(midWrite!.target).toBe(before);
    expect(
      midWrite!.entries.some(
        (entry) => entry.startsWith(`${SECRETS_ENV_FILE}.`) && entry.endsWith(".tmp"),
      ),
    ).toBe(true);
    expect(await readFile(secretsPath, "utf8")).toBe(before);
    // Neither the temporary file nor the lock survives the interruption.
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith(`${SECRETS_ENV_FILE}.`)),
    ).toEqual([]);
  });

  it("recovers a stale lock and refuses a live lock after the declared wait bound", async () => {
    const root = await configuredSplitRoot("docsfab-1117-lock-");
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const lockPath = join(root, SECRETS_ENV_LOCK_FILE);

    // A lock from another host, older than the stale bound, is recovered.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 1, host: "unrelated-host.invalid", token: "stale" }),
      { mode: 0o600 },
    );
    const past = new Date(Date.now() - 86_400_000);
    await utimes(lockPath, past, past);
    await writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]]);
    expect(await readFile(secretsPath, "utf8")).toContain(`MODEL_API_KEY=${OTHER_KEY}`);
    expect(await readdir(root)).not.toContain(SECRETS_ENV_LOCK_FILE);

    // A lock held by a live process on this host is honored however old it is,
    // until the declared wait bound, then refused with the coded limit message.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), token: "live" }),
      { mode: 0o600 },
    );
    await utimes(lockPath, past, past);
    const wait = limitDefinition("secrets.lockWaitMs");
    const stale = limitDefinition("secrets.lockStaleMs");
    const retry = limitDefinition("secrets.lockRetryMs");
    const waitBound = retry.value * 2;
    expect(waitBound).toBeGreaterThanOrEqual(wait.min);
    expect(waitBound).toBeLessThanOrEqual(wait.max);
    expect(stale.min).toBeLessThan(waitBound);
    await expect(
      writeSecretsEnvFile(root, [["MODEL_API_KEY", STORED_KEY]], {
        environment: secretsLockOverrideEnvironment({
          "secrets.lockWaitMs": waitBound,
          "secrets.lockStaleMs": stale.min,
          "secrets.lockRetryMs": retry.min,
        }),
      }),
    ).rejects.toThrow(
      new RegExp(
        `^secrets-lock-wait-ms-bound: \\d+ exceeds secrets\\.lockWaitMs = ${waitBound} ms\\.`,
        "u",
      ),
    );
    expect(await readFile(secretsPath, "utf8")).toContain(`MODEL_API_KEY=${OTHER_KEY}`);
    expect(await readFile(lockPath, "utf8")).toContain('"token":"live"');
  });

  it("recovers an other-host lock at a host-shrunk stale bound younger than the catalog default", async () => {
    const root = await configuredSplitRoot("docsfab-1117-stale-override-");
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const lockPath = join(root, SECRETS_ENV_LOCK_FILE);
    const stale = limitDefinition("secrets.lockStaleMs");
    expect(stale.min).toBeLessThan(stale.value);
    const ageMs = stale.value - stale.min;
    expect(ageMs).toBeGreaterThanOrEqual(stale.min);
    expect(ageMs).toBeLessThan(stale.value);

    await writeFile(
      lockPath,
      JSON.stringify({ pid: 1, host: "unrelated-host.invalid", token: "foreign" }),
      { mode: 0o600 },
    );
    const aged = new Date(Date.now() - ageMs);
    await utimes(lockPath, aged, aged);

    await writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]], {
      environment: secretsLockOverrideEnvironment({ "secrets.lockStaleMs": stale.min }),
    });
    expect(await readFile(secretsPath, "utf8")).toContain(`MODEL_API_KEY=${OTHER_KEY}`);
    expect(await readdir(root)).not.toContain(SECRETS_ENV_LOCK_FILE);
  });

  it("refuses a raised or malformed secrets-lock host override on the write path", async () => {
    const root = await configuredSplitRoot("docsfab-1117-lock-override-refuse-");
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const before = await readFile(secretsPath, "utf8");
    for (const name of [
      "secrets.lockStaleMs",
      "secrets.lockRetryMs",
      "secrets.lockWaitMs",
    ] as const) {
      const definition = limitDefinition(name);
      const key = definition.override;
      expect(key).toMatch(/^DOCSFAB_[A-Z0-9_]+$/u);
      await expect(
        writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]], {
          environment: { [key!]: String(definition.max + 1) },
        }),
      ).rejects.toThrow(
        `${key} must be an integer between ${definition.min} and ${definition.max}.`,
      );
      await expect(
        writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]], {
          environment: { [key!]: "not-an-integer" },
        }),
      ).rejects.toThrow(
        `${key} must be an integer between ${definition.min} and ${definition.max}.`,
      );
    }
    expect(await readFile(secretsPath, "utf8")).toBe(before);
  });

  it("leaves a root whose .env stores only the key unchanged at startup, and guided setup asks for a provider", async () => {
    const root = await temporaryConfigurationRoot("docsfab-1117-key-only-env-");
    const envPath = join(root, ".env");
    await writeFile(envPath, `MODEL_API_KEY=${STORED_KEY}\n`, { mode: 0o600 });
    const before = await fileIdentity(envPath);
    await pause();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        ensureLiveAgentConfiguration({
          environment: { DOCSFAB_CONFIG_ROOT: root },
          input: Object.assign(new PassThrough(), { isTTY: false }),
          output: Object.assign(new PassThrough(), { isTTY: false }),
        }),
      ).rejects.toThrow(/Next action: docsfab setup/u);
      // Startup did not switch the root to the split layout or strand the key.
      expect((await readdir(root)).sort()).toEqual([".env"]);
      expect(await fileIdentity(envPath)).toEqual(before);
    }

    // A stored key does not choose a model: guided setup asks for one first.
    const stopAtQuestion = async (label: string): Promise<string> => {
      throw new Error(`guided setup continued to ${label}`);
    };
    await expect(
      ensureLiveAgentConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root },
        ...terminalStreams(),
        prompter: {
          readChoice: stopAtQuestion,
          readValue: stopAtQuestion,
          readSecret: stopAtQuestion,
        },
      }),
    ).rejects.toThrow("guided setup continued to Provider");
    expect((await readdir(root)).sort()).toEqual([".env"]);
    expect(await fileIdentity(envPath)).toEqual(before);

    // An explicit composition choice completes the root from the stored key.
    const selected = await runSetupBootstrap({
      profile: INTERNAL_SETUP_EXECUTION_PROFILE,
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(selected).toMatchObject({
      status: "ready",
      credentialSource: "existing-env",
    });
    expect(await readFile(join(root, SECRETS_ENV_FILE), "utf8")).toContain(
      `MODEL_API_KEY=${STORED_KEY}`,
    );
  });

  it(
    "never takes the lock from a live writer in another process, however old the lock is",
    async () => {
      const root = await configuredSplitRoot("docsfab-1117-two-process-");
      const secretsPath = join(root, SECRETS_ENV_FILE);
      const lockPath = join(root, SECRETS_ENV_LOCK_FILE);
      const signals = await temporaryConfigurationRoot("docsfab-1117-signals-");
      const [readyA, holdA, releaseA, readyB] = ["ready-a", "hold-a", "release-a", "ready-b"].map(
        (name) => join(signals, name),
      );
      const valueA = "sk-issue-1117-writer-a-fixture";
      const valueB = "sk-issue-1117-writer-b-fixture";

      const writerA = runWriter([root, "OPENAI_API_KEY", valueA, readyA, holdA, releaseA]);
      await waitForFile(holdA);
      // Writer A holds the lock between its flushed temporary file and the
      // rename. Age the lock far past secrets.lockStaleMs.
      const aged = new Date(Date.now() - 86_400_000);
      await utimes(lockPath, aged, aged);

      const writerB = runWriter([root, "ANTHROPIC_API_KEY", valueB, readyB]);
      await waitForFile(readyB);
      await pause(500);
      // Writer B is waiting: it neither took the lock nor wrote.
      expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(
        Number(await readFile(holdA, "utf8")),
      );
      expect(await readFile(secretsPath, "utf8")).not.toContain(valueB);

      await writeFile(releaseA, "release");
      const [resultA, resultB] = await Promise.all([writerA, writerB]);
      expect(resultA).toEqual({ code: 0, stderr: "" });
      expect(resultB).toEqual({ code: 0, stderr: "" });

      const source = await readFile(secretsPath, "utf8");
      expect(source).toContain(`OPENAI_API_KEY=${valueA}`);
      expect(source).toContain(`ANTHROPIC_API_KEY=${valueB}`);
      expect(source).toContain(`MODEL_API_KEY=${STORED_KEY}`);
      expectWellFormedSecrets(source);
      expect(await readdir(root)).not.toContain(SECRETS_ENV_LOCK_FILE);
    },
    testTimeoutMs(WRITER_HOLD_CASE_LOCAL_MS),
  );

  it("keeps the held writer's release wait strictly inside its case budget, locally and in CI", () => {
    // The value the two-process case above uses, in this run's environment.
    expect(WRITER_RELEASE_TIMEOUT_MS).toBeLessThan(testTimeoutMs(WRITER_HOLD_CASE_LOCAL_MS));
    for (const environment of [{}, { CI: "true" }]) {
      const release = nestedDeadlineMs(
        WRITER_RELEASE_LOCAL_MS,
        WRITER_HOLD_CASE_LOCAL_MS,
        environment,
      );
      expect(release).toBeLessThan(testTimeoutMs(WRITER_HOLD_CASE_LOCAL_MS, environment));
      expect(release).toBeGreaterThan(WRITER_MARKER_WAIT_MS);
    }
  });

  // Adjacent to the two-process case above, where the release file arrives:
  // here it never does. Without the deadline check in WRITER_SOURCE's
  // released(), this writer would poll forever instead of failing with the
  // message below.
  it(
    "fails a held writer with its own message when the release file never arrives",
    async () => {
      const root = await configuredSplitRoot("docsfab-1117-writer-release-timeout-");
      const signals = await temporaryConfigurationRoot("docsfab-1117-writer-release-signals-");
      const ready = join(signals, "ready");
      const hold = join(signals, "hold");
      const release = join(signals, "never-written-release");
      const result = await runWriter(
        [root, "OPENAI_API_KEY", "release-timeout-fixture-value", ready, hold, release],
        100,
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`timed out after 100ms waiting for ${release}`);
    },
    testTimeoutMs(WRITER_HOLD_CASE_LOCAL_MS),
  );

  it("refuses to rename when another writer took the lock mid-write", async () => {
    const root = await configuredSplitRoot("docsfab-1117-lock-lost-");
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const lockPath = join(root, SECRETS_ENV_LOCK_FILE);
    const before = await readFile(secretsPath, "utf8");
    const foreignOwner = JSON.stringify({ pid: process.pid, host: hostname(), token: "other" });

    await expect(
      writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]], {
        async onTemporaryWritten() {
          await writeFile(lockPath, foreignOwner, { mode: 0o600 });
        },
      }),
    ).rejects.toThrow(/^secrets-env-lock-lost: /u);

    expect(await readFile(secretsPath, "utf8")).toBe(before);
    // The other writer's lock is left for its owner; no temporary copy remains.
    expect(await readFile(lockPath, "utf8")).toBe(foreignOwner);
    expect(
      (await readdir(root)).filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".stale")),
    ).toEqual([]);
  });

  it("removes temporary secrets copies and change backups a crashed writer left behind, and nothing else", async () => {
    const root = await configuredSplitRoot("docsfab-1117-orphans-");
    await mkdir(join(root, "profiles"), { recursive: true });
    const deadPid = await exitedProcessId();
    const orphans = [
      `${SECRETS_ENV_FILE}.${deadPid}.${randomUUID()}.tmp`,
      `${SECRETS_ENV_LOCK_FILE}.${deadPid}.${randomUUID()}.stale`,
      `${SECRETS_ENV_FILE}.${deadPid}.${randomUUID()}.bak`,
      `host.yaml.${deadPid}.${randomUUID()}.bak`,
      `profiles/model.yaml.${deadPid}.${randomUUID()}.bak`,
      `host.yaml.${deadPid}.${randomUUID()}.tmp`,
      `profiles/model.yaml.${deadPid}.${randomUUID()}.tmp`,
    ];
    // A symbolic link a crashed restore of a symlinked secrets.env left behind.
    const orphanedLink = `${SECRETS_ENV_FILE}.${deadPid}.${randomUUID()}.tmp`;
    const kept = [
      // A live writer's files, originals an incomplete change kept, and names
      // outside the pattern.
      `${SECRETS_ENV_FILE}.${process.pid}.${randomUUID()}.tmp`,
      `host.yaml.${process.pid}.${randomUUID()}.bak`,
      `profiles/model.yaml.${process.pid}.${randomUUID()}.bak`,
      `host.yaml.setup-incomplete.${randomUUID()}.bak`,
      `${SECRETS_ENV_FILE}.backup`,
    ];
    for (const name of [...orphans, ...kept]) {
      await writeFile(join(root, name), "MODEL_API_KEY=sk-issue-1117-orphan-fixture\n", {
        mode: 0o600,
      });
    }
    await symlink("stored-secrets.env", join(root, orphanedLink));
    orphans.push(orphanedLink);

    await writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]]);

    const entries = [
      ...(await readdir(root)),
      ...(await readdir(join(root, "profiles"))).map((name) => `profiles/${name}`),
    ];
    for (const name of orphans) expect(entries).not.toContain(name);
    for (const name of kept) expect(entries).toContain(name);
  });

  it("refuses at once when the lock path is a broken symbolic link", async () => {
    const root = await configuredSplitRoot("docsfab-1117-lock-symlink-");
    const lockPath = join(root, SECRETS_ENV_LOCK_FILE);
    await symlink(join(root, "missing-lock-target"), lockPath);
    const started = Date.now();

    await expect(writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]])).rejects.toThrow(
      /^secrets-env-lock-invalid: .*is not a regular file/u,
    );

    // The refusal did not spin until the 15 s secrets.lockWaitMs bound.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await readFile(join(root, SECRETS_ENV_FILE), "utf8")).toContain(
      `MODEL_API_KEY=${STORED_KEY}`,
    );
  });

  it("resolves lower-only lock overrides from the environment, the configuration root, or the host limits file", async () => {
    const emptyRoot = await temporaryConfigurationRoot("docsfab-1117-empty-limits-root-");
    const fromEnvironment = resolveSecretsEnvLockLimits(
      {
        DOCSFAB_CONFIG_ROOT: emptyRoot,
        DOCSFAB_SECRETS_LOCK_WAIT_MS: "400",
        DOCSFAB_SECRETS_LOCK_STALE_MS: "50",
        DOCSFAB_SECRETS_LOCK_RETRY_MS: "5",
      },
      emptyRoot,
    );
    expect(
      [fromEnvironment.wait, fromEnvironment.stale, fromEnvironment.retry].map(
        ({ name, value, source }) => ({ name, value, source }),
      ),
    ).toEqual([
      { name: "secrets.lockWaitMs", value: 400, source: "host" },
      { name: "secrets.lockStaleMs", value: 50, source: "host" },
      { name: "secrets.lockRetryMs", value: 5, source: "host" },
    ]);

    const hostDirectory = await temporaryConfigurationRoot("docsfab-1117-host-limits-");
    const hostFile = join(hostDirectory, "service.env");
    await writeFile(
      hostFile,
      "DOCSFAB_SECRETS_LOCK_STALE_MS=60\nDOCSFAB_SECRETS_LOCK_RETRY_MS=7\n",
    );
    const fromHostFile = resolveSecretsEnvLockLimits(
      { DOCSFAB_CONFIG_ROOT: emptyRoot, DOCSFAB_SERVICE_ENV_FILE: hostFile },
      emptyRoot,
    );
    expect([fromHostFile.stale.value, fromHostFile.retry.value]).toEqual([60, 7]);
    expect(
      resolveSecretsEnvLockLimits({ DOCSFAB_CONFIG_ROOT: emptyRoot }, emptyRoot).stale.value,
    ).toBe(10_000);

    // Override keys stored in the configuration root are one more tier, read
    // the same way doctor --limits reads them.
    const root = await configuredSplitRoot("docsfab-1117-root-limits-");
    await writeSecretsEnvFile(root, [
      ["DOCSFAB_SECRETS_LOCK_STALE_MS", "70"],
      ["DOCSFAB_SECRETS_LOCK_RETRY_MS", "9"],
    ]);
    const environment = { DOCSFAB_CONFIG_ROOT: root };
    const lock = resolveSecretsEnvLockLimits(environment, root);
    const doctor = resolveLimits({ environment: loadEffectiveLimitEnvironment(environment) });
    for (const limit of [lock.wait, lock.stale, lock.retry]) {
      const reported = doctor.find((entry) => entry.name === limit.name)!;
      expect({ value: limit.value, source: limit.source }).toEqual({
        value: reported.value,
        source: reported.source,
      });
    }
    expect([lock.stale.value, lock.retry.value]).toEqual([70, 9]);
  });

  it("refuses a lock override stored in the configuration root before setup rewrites anything", async () => {
    const root = await configuredSplitRoot("docsfab-1117-root-limits-refuse-");
    await writeSecretsEnvFile(root, [["DOCSFAB_SECRETS_LOCK_WAIT_MS", "100"]]);
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const before = await fileIdentity(secretsPath);
    await pause();

    await expect(
      runSetupBootstrap({ environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: OTHER_KEY } }),
    ).rejects.toThrow(
      /^secrets-lock-override-invalid: DOCSFAB_SECRETS_LOCK_STALE_MS 10000 must be < DOCSFAB_SECRETS_LOCK_WAIT_MS 100\./u,
    );
    expect(await fileIdentity(secretsPath)).toEqual(before);
  });

  it.each([
    [
      "DOCSFAB_SECRETS_LOCK_STALE_MS",
      "10001",
      /DOCSFAB_SECRETS_LOCK_STALE_MS must be an integer between 1 and 10000\./u,
    ],
    [
      "DOCSFAB_SECRETS_LOCK_RETRY_MS",
      "26",
      /DOCSFAB_SECRETS_LOCK_RETRY_MS must be an integer between 1 and 25\./u,
    ],
    [
      "DOCSFAB_SECRETS_LOCK_RETRY_MS",
      "soon",
      /DOCSFAB_SECRETS_LOCK_RETRY_MS must be an integer between 1 and 25\./u,
    ],
    [
      "DOCSFAB_SECRETS_LOCK_WAIT_MS",
      "0",
      /DOCSFAB_SECRETS_LOCK_WAIT_MS must be an integer between 1 and 15000\./u,
    ],
    [
      "DOCSFAB_SECRETS_LOCK_WAIT_MS",
      "100",
      /DOCSFAB_SECRETS_LOCK_STALE_MS 10000 must be < DOCSFAB_SECRETS_LOCK_WAIT_MS 100\./u,
    ],
  ])("refuses %s=%s before touching configuration", async (name, value, message) => {
    const root = await configuredSplitRoot("docsfab-1117-invalid-override-");
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const before = await fileIdentity(secretsPath);
    const fresh = await temporaryConfigurationRoot("docsfab-1117-invalid-override-fresh-");
    const coded = /^secrets-lock-override-invalid: /u;

    for (const attempt of [
      () =>
        writeSecretsEnvFile(root, [["MODEL_API_KEY", OTHER_KEY]], {
          environment: { [name]: value },
        }),
      () =>
        runSetupBootstrap({
          environment: { DOCSFAB_CONFIG_ROOT: root, [name]: value },
        }),
      () =>
        runSetupBootstrap({
          environment: {
            DOCSFAB_CONFIG_ROOT: fresh,
            MODEL_API_KEY: OTHER_KEY,
            [name]: value,
          },
        }),
      () =>
        ensureLiveAgentConfiguration({
          environment: { DOCSFAB_CONFIG_ROOT: root, [name]: value },
          ...terminalStreams(),
        }),
    ]) {
      const refusal = attempt();
      await expect(refusal).rejects.toThrow(coded);
      await expect(refusal).rejects.toThrow(message);
    }
    expect(await fileIdentity(secretsPath)).toEqual(before);
    expect(await readdir(fresh)).toEqual([]);
  });

  it.each([
    ["a .env that holds only the key, with a different key exported", ".env", "MODEL_API_KEY"],
    [
      "a secrets.env without host.yaml, with a different key exported",
      SECRETS_ENV_FILE,
      "MODEL_API_KEY",
    ],
    ["a .env that holds only the key, with an unrelated key exported", ".env", "OPENAI_API_KEY"],
    [
      "a secrets.env without host.yaml, with an unrelated key exported",
      SECRETS_ENV_FILE,
      "OPENAI_API_KEY",
    ],
  ])(
    "guided setup asks for a provider for %s and leaves the stored key as it is",
    async (_label, fileName, exportedName) => {
      const root = await temporaryConfigurationRoot("docsfab-1117-guided-stored-");
      const storedPath = join(root, fileName);
      await writeFile(storedPath, `MODEL_API_KEY=${STORED_KEY}\n`, {
        mode: 0o600,
      });
      const before = await fileIdentity(storedPath);
      const questions: string[] = [];
      const stop = async (label: string): Promise<string> => {
        questions.push(label);
        throw new Error(`guided setup continued to ${label}`);
      };

      await expect(
        ensureLiveAgentConfiguration({
          environment: { DOCSFAB_CONFIG_ROOT: root, [exportedName]: OTHER_KEY },
          ...terminalStreams(),
          prompter: { readChoice: stop, readValue: stop, readSecret: stop },
        }),
      ).rejects.toThrow("guided setup continued to Provider");
      // Neither the stored nor the exported key chooses a model.
      expect(questions).toEqual(["Provider"]);
      expect((await readdir(root)).sort()).toEqual([fileName]);
      expect(await fileIdentity(storedPath)).toEqual(before);
    },
  );

  it("offers to save an exported MODEL_API_KEY for a legacy selection that declares no names", async () => {
    const root = await temporaryConfigurationRoot("docsfab-1117-guided-legacy-");
    // A legacy .env that names a model but is incomplete, and stores no key.
    const envPath = join(root, ".env");
    await writeFile(
      envPath,
      "MODEL_PROVIDER=nvidia-inference-api\nMODEL_ID=azure/openai/gpt-6-sol\n",
      { mode: 0o600 },
    );
    const before = await fileIdentity(envPath);
    const questions: string[] = [];
    const prompter = {
      async readChoice(label: string) {
        questions.push(label);
        if (label.startsWith("No saved API key was found")) return "no";
        throw new Error(`guided setup continued to ${label}`);
      },
      async readValue(label: string): Promise<string> {
        throw new Error(`guided setup continued to ${label}`);
      },
      async readSecret(label: string): Promise<string> {
        throw new Error(`guided setup continued to ${label}`);
      },
    };

    await expect(
      ensureLiveAgentConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: OTHER_KEY },
        ...terminalStreams(),
        prompter,
      }),
    ).rejects.toThrow("guided setup continued to Provider");
    expect(questions).toEqual([
      `No saved API key was found. Save the exported MODEL_API_KEY to ${join(root, SECRETS_ENV_FILE)}?`,
      "Provider",
    ]);
    expect(await fileIdentity(envPath)).toEqual(before);
  });

  it("does not offer to save an exported key when no model is selected", async () => {
    const root = await temporaryConfigurationRoot("docsfab-1117-guided-consent-");
    // An incomplete root with no stored key: an all-empty secrets.env, no host.yaml.
    await writeSecretsEnvFile(
      root,
      SECRET_ENV_KEYS.map((key) => [key, ""] as const),
    );
    const before = await fileIdentity(join(root, SECRETS_ENV_FILE));
    const questions: string[] = [];
    const stop = async (label: string): Promise<string> => {
      questions.push(label);
      throw new Error(`guided setup continued to ${label}`);
    };

    await expect(
      ensureLiveAgentConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: OTHER_KEY },
        ...terminalStreams(),
        prompter: { readChoice: stop, readValue: stop, readSecret: stop },
      }),
    ).rejects.toThrow("guided setup continued to Provider");
    expect(questions).toEqual(["Provider"]);
    expect(await fileIdentity(join(root, SECRETS_ENV_FILE))).toEqual(before);
  });

  it("never offers to save an exported key under an unrelated name", async () => {
    const root = await temporaryConfigurationRoot("docsfab-1117-guided-unrelated-");
    await writeSecretsEnvFile(
      root,
      SECRET_ENV_KEYS.map((key) => [key, ""] as const),
    );
    const before = await fileIdentity(join(root, SECRETS_ENV_FILE));
    const questions: string[] = [];
    const recordAndStop = async (label: string): Promise<string> => {
      questions.push(label);
      throw new Error(`guided setup continued to ${label}`);
    };

    await expect(
      ensureLiveAgentConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root, OPENAI_API_KEY: OTHER_KEY },
        ...terminalStreams(),
        prompter: {
          readChoice: recordAndStop,
          readValue: recordAndStop,
          readSecret: recordAndStop,
        },
      }),
    ).rejects.toThrow(/guided setup continued to Provider/u);
    expect(questions).toEqual(["Provider"]);
    expect(await fileIdentity(join(root, SECRETS_ENV_FILE))).toEqual(before);
  });

  describe("lossless secrets.env updates (review note 70878928)", () => {
    // Lines an operator may keep beside the DocsFab keys. An update of another
    // key does not rewrite any of them.
    const NEIGHBOUR_LINES = [
      "# operator comment",
      "export SERVICE_TOKEN=token-fixture",
      "SPACED_KEY = spaced value",
      "MY-HYPHEN=hyphen-fixture",
      "lower_key=lower-fixture",
      'MULTI_LINE="first line',
      "second line",
      'third line"',
      'HASH_Q="abc#def"',
      "HASH_BARE=abc#def",
      'BACKSLASH_Q="a' + BACKSLASH + BACKSLASH + 'b"',
      "SINGLE_Q=" + QUOTE + "a b" + QUOTE,
      "UNKNOWN_KEY=v",
      "",
      "   ",
    ];
    const VALUES = [
      "abc#def",
      "a" + BACKSLASH + "b",
      "a" + DOUBLE_QUOTE + "b",
      "it" + QUOTE + "s",
      "with space",
      "a=b=c",
      "ünïcödé ✓ 鍵",
      "  padded  ",
      "#leading-hash",
      BACKSLASH + DOUBLE_QUOTE + "mixed" + QUOTE + "#" + BACKSLASH + BACKSLASH + " ",
      DOUBLE_QUOTE + "quoted" + DOUBLE_QUOTE,
      QUOTE + "single" + QUOTE,
      "trailing" + BACKSLASH,
    ];

    async function rootWithNeighbours(lineEnding: string): Promise<string> {
      const root = await configuredSplitRoot("docsfab-1117-lossless-");
      const secretsPath = join(root, SECRETS_ENV_FILE);
      const stored = (await readFile(secretsPath, "utf8")).replace(/\n/gu, lineEnding);
      await writeFile(secretsPath, stored + NEIGHBOUR_LINES.join(lineEnding) + lineEnding, {
        mode: 0o600,
      });
      return root;
    }

    /** Lines of the file that do not assign any of the given keys. */
    function untouchedLines(source: string, keys: ReadonlySet<string>): string[] {
      return source
        .split(/(?<=\r\n|\n)/u)
        .filter((line) => !keys.has(parseDotenvLine(line.replace(/\r?\n$/u, ""))?.key ?? ""));
    }

    it.each([
      ["LF", "\n"],
      ["CRLF", "\r\n"],
    ])(
      "round-trips every value class and keeps every other line byte for byte (%s)",
      async (_label, lineEnding) => {
        const root = await rootWithNeighbours(lineEnding);
        const secretsPath = join(root, SECRETS_ENV_FILE);
        const before = await readFile(secretsPath, "utf8");
        const beforeValues = parseDotenvAssignments(before);
        const written = new Map<string, string>();
        const writtenKeys = new Set<string>(["JUDGE_API_KEY"]);

        for (const [index, value] of VALUES.entries()) {
          const key = `ROUNDTRIP_${index}`;
          written.set(key, value);
          writtenKeys.add(key);
          await writeSecretsEnvFile(root, [[key, value]]);
          // Several writes of an unrelated key after each value.
          for (let round = 0; round < 3; round += 1) {
            await writeSecretsEnvFile(root, [["JUDGE_API_KEY", `judge-${index}-${round}`]]);
          }
          const source = await readFile(secretsPath, "utf8");
          const values = parseDotenvAssignments(source);
          for (const [writtenKey, writtenValue] of written) {
            expect(values.get(writtenKey)).toBe(writtenValue);
          }
          expect(untouchedLines(source, writtenKeys)).toEqual(untouchedLines(before, writtenKeys));
        }

        // The runtime loader reads the same values, and untouched keys keep theirs.
        const loaded: NodeJS.ProcessEnv = {};
        loadEnvFileIntoEnvironment(secretsPath, loaded);
        for (const [key, value] of written) expect(loaded[key]).toBe(value);
        for (const [key, value] of beforeValues) {
          if (!writtenKeys.has(key)) expect(loaded[key]).toBe(value);
        }
        expect(loaded.HASH_Q).toBe("abc#def");
        expect(loaded.HASH_BARE).toBe("abc#def");
        expect(loaded.BACKSLASH_Q).toBe("a" + BACKSLASH + "b");
        expect(loaded.MODEL_API_KEY).toBe(STORED_KEY);
      },
    );

    it("replaces a changed key in place, keeping its export prefix and line position", async () => {
      const root = await rootWithNeighbours("\n");
      const secretsPath = join(root, SECRETS_ENV_FILE);
      await writeSecretsEnvFile(root, [["SERVICE_TOKEN", "rotated token"]]);
      const lines = (await readFile(secretsPath, "utf8")).split("\n");
      const rotated = "export SERVICE_TOKEN=" + DOUBLE_QUOTE + "rotated token" + DOUBLE_QUOTE;
      expect(lines).toContain(rotated);
      expect(lines.filter((line) => line.includes("SERVICE_TOKEN"))).toHaveLength(1);
      expect(lines.indexOf(rotated)).toBeLessThan(lines.indexOf("UNKNOWN_KEY=v"));
    });

    it.each([
      ["a line feed", "first\nsecond"],
      ["a carriage return", "first\rsecond"],
      ["a NUL character", "first" + String.fromCharCode(0) + "second"],
    ])(
      "refuses a value containing %s, naming the key and never the value",
      async (_label, value) => {
        const root = await rootWithNeighbours("\n");
        const secretsPath = join(root, SECRETS_ENV_FILE);
        const before = await fileIdentity(secretsPath);
        const refusal = await writeSecretsEnvFile(root, [["JUDGE_API_KEY", value]]).then(
          () => "",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(refusal).toMatch(
          /^secrets-env-value-unrepresentable: The value for JUDGE_API_KEY /u,
        );
        expect(refusal).not.toContain("first");
        expect(await fileIdentity(secretsPath)).toEqual(before);
      },
    );

    it("refuses to replace a multi-line value instead of orphaning its continuation lines", async () => {
      const root = await rootWithNeighbours("\n");
      const secretsPath = join(root, SECRETS_ENV_FILE);
      const before = await fileIdentity(secretsPath);
      await expect(writeSecretsEnvFile(root, [["MULTI_LINE", "single line"]])).rejects.toThrow(
        /^secrets-env-line-unsupported: The MULTI_LINE assignment on line \d+ of secrets\.env continues onto later lines/u,
      );
      expect(await fileIdentity(secretsPath)).toEqual(before);
    });

    it("keeps every other line when explicit setup saves a new key", async () => {
      const root = await rootWithNeighbours("\n");
      const secretsPath = join(root, SECRETS_ENV_FILE);
      const before = await readFile(secretsPath, "utf8");
      const setupKeys = new Set<string>([...SECRET_ENV_KEYS]);

      const result = await runSetupBootstrap({
        environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: OTHER_KEY },
      });
      expect(result.status).toBe("ready");
      const afterSetup = await readFile(secretsPath, "utf8");
      expect(untouchedLines(afterSetup, setupKeys)).toEqual(untouchedLines(before, setupKeys));
      expect(parseDotenvAssignments(afterSetup).get("MODEL_API_KEY")).toBe(OTHER_KEY);
    });
  });

  describe("ordinary dotenv lines in the configuration root (review note 70874374)", () => {
    const ORDINARY_LINES = [
      "export FOO=bar",
      `export MODEL_API_KEY=${STORED_KEY}`,
      "FOO = bar",
      "FOO-BAR=1",
      'FOO="first line\nsecond line"',
      "export DOCSFAB_SECRETS_LOCK_RETRY_MS=10",
    ] as const;

    const readyLegacyEnv = [
      "MODEL_PROVIDER=nvidia-inference-api",
      `MODEL_BASE_URL=${HUB_BASE_URL}`,
      "MODEL_ID=azure/openai/gpt-5.4",
      "MODEL_API_FORMAT=chat_completions",
      `MODEL_API_KEY=${STORED_KEY}`,
      "MODEL_CONTEXT_WINDOW=1000000",
      "MODEL_MAX_INPUT_TOKENS=1000000",
      "MODEL_MAX_OUTPUT_TOKENS=128000",
      "MODEL_API_MIN_OUTPUT_TOKENS=16",
      "MODEL_CONTEXT_RESERVE_TOKENS=4096",
      "MODEL_REASONING=true",
      "MODEL_INPUT_TYPES=text",
      "MODEL_SUPPORTS_DEVELOPER_ROLE=false",
      "MODEL_SUPPORTS_REASONING_EFFORT=false",
      "MODEL_COMPATIBLE_API_FORMATS=chat_completions",
      "MODEL_INPUT_COST_PER_MILLION=unknown",
      "MODEL_OUTPUT_COST_PER_MILLION=unknown",
      "MODEL_CACHE_READ_COST_PER_MILLION=unknown",
      "MODEL_CACHE_WRITE_COST_PER_MILLION=unknown",
      ...GPT_54_OPERATOR_ATTESTATION_LINES,
      "",
    ].join("\n");

    type Layout =
      | "configured split root"
      | "configured legacy .env root"
      | "key-only legacy .env root";
    const LAYOUTS: readonly Layout[] = [
      "configured split root",
      "configured legacy .env root",
      "key-only legacy .env root",
    ];

    async function rootWithLine(layout: Layout, line: string): Promise<string> {
      if (layout === "configured split root") {
        const root = await configuredSplitRoot("docsfab-1117-ordinary-split-");
        await appendFile(join(root, SECRETS_ENV_FILE), `${line}\n`);
        return root;
      }
      const root = await temporaryConfigurationRoot("docsfab-1117-ordinary-legacy-");
      const base =
        layout === "configured legacy .env root" ? readyLegacyEnv : `MODEL_API_KEY=${STORED_KEY}\n`;
      await writeFile(join(root, ".env"), `${base}${line}\n`, { mode: 0o600 });
      return root;
    }

    it.each(LAYOUTS.flatMap((layout) => ORDINARY_LINES.map((line) => [layout, line] as const)))(
      "%s with %j starts, sets up, writes, and agrees with doctor",
      async (layout, line) => {
        const root = await rootWithLine(layout, line);
        const environment = { DOCSFAB_CONFIG_ROOT: root };
        const expectedRetry = line.includes("DOCSFAB_SECRETS_LOCK_RETRY_MS") ? 10 : 25;

        // doctor --limits and the lock read the same tier and agree before any write.
        const lock = resolveSecretsEnvLockLimits(environment, root);
        const doctor = resolveLimits({ environment: loadEffectiveLimitEnvironment(environment) });
        expect(lock.retry.value).toBe(expectedRetry);
        expect(doctor.find((entry) => entry.name === "secrets.lockRetryMs")!.value).toBe(
          expectedRetry,
        );

        const keyOnly = layout === "key-only legacy .env root";
        const startup = await runSetupBootstrap({
          environment,
          purpose: "startup-check",
        });
        expect(startup.status).toBe(keyOnly ? "blocked-model-choice-required" : "ready");
        // A key-only root names no model, so it completes only through an explicit choice.
        const setup = await runSetupBootstrap({
          ...(keyOnly ? { profile: INTERNAL_SETUP_EXECUTION_PROFILE } : {}),
          environment,
        });
        expect(setup.status).toBe("ready");
        await expect(
          writeSecretsEnvFile(root, [["JUDGE_API_KEY", OTHER_KEY]], { environment }),
        ).resolves.toBeDefined();
      },
    );

    it.each([
      [
        "configured split root",
        "export DOCSFAB_SECRETS_LOCK_RETRY_MS=abc",
        "configuration root secrets.env",
      ],
      [
        "configured split root",
        "DOCSFAB_SECRETS_LOCK_RETRY_MS = 99999",
        "configuration root secrets.env",
      ],
      [
        "configured legacy .env root",
        "export DOCSFAB_SECRETS_LOCK_RETRY_MS=abc",
        "configuration root .env",
      ],
      [
        "key-only legacy .env root",
        "DOCSFAB_SECRETS_LOCK_RETRY_MS = 99999",
        "configuration root .env",
      ],
    ] as const)(
      "%s with %j still refuses the invalid override and names its file",
      async (layout, line, kind) => {
        const root = await rootWithLine(layout, line);
        const environment = { DOCSFAB_CONFIG_ROOT: root };
        const filePath = join(root, layout === "configured split root" ? SECRETS_ENV_FILE : ".env");
        const before = await fileIdentity(filePath);
        const lineNumber = (await readFile(filePath, "utf8")).split("\n").indexOf(line) + 1;

        for (const attempt of [
          () => runSetupBootstrap({ environment, purpose: "startup-check" }),
          () => runSetupBootstrap({ environment }),
          () => writeSecretsEnvFile(root, [["JUDGE_API_KEY", OTHER_KEY]], { environment }),
        ]) {
          const refusal = await attempt().then(
            () => undefined,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
          expect(refusal).toMatch(
            /^secrets-lock-override-invalid: DOCSFAB_SECRETS_LOCK_RETRY_MS must be an integer between 1 and 25\./u,
          );
          expect(refusal).toContain(
            `Set: DOCSFAB_SECRETS_LOCK_RETRY_MS from the ${kind} (${filePath}, line ${lineNumber}).`,
          );
          expect(refusal).not.toContain("Host limits file");
          expect(refusal).not.toMatch(/abc|99999/u);
        }
        expect(await fileIdentity(filePath)).toEqual(before);
      },
    );
  });
});
