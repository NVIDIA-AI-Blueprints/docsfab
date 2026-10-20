// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An unreadable host limits file. The installed default that this user may
 * not read is skipped with one coded notice per process, whichever reader
 * meets it first; a file that DOCSFAB_SERVICE_ENV_FILE names, and any other
 * read error, refuses with the coded envelope. The CLI cases run the built
 * entry point, `bin/docsfab.mjs`; the screen cases run a process that loads
 * only the configured-credential screens, as the host's tools do. A preload
 * redirects reads of the installed path, so the resolved default itself, not
 * the variable, reaches the fixture file.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import {
  HOST_LIMITS_FILE,
  HOST_LIMITS_FILE_REMEDIATION,
  HOST_LIMITS_FILE_UNREADABLE,
  HostLimitsFileError,
  noteHostLimitFileRefused,
  readHostLimitFile,
  readHostLimitFileAt,
  reportHostLimitFile,
  resolveHostLimitFileSource,
} from "../src/config/limit-resolution.js";
import { resolveSecretsEnvLockLimits } from "../src/config/split-layout.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const RUNTIME_ROOT = resolve(import.meta.dirname, "..");
const BIN = join(RUNTIME_ROOT, "bin", "docsfab.mjs");
const SCREENS = join(RUNTIME_ROOT, "src", "security", "configured-credentials.js");
const REPORTER = join(RUNTIME_ROOT, "src", "operator", "error-envelope.ts");
const TSX_LOADER = join(RUNTIME_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
// Root reads a mode-000 file, so those cases cannot fail the read as root.
const runsAsRoot = process.getuid?.() === 0;

// Values differ from each other and from the catalog default, so a file that
// was read, or the wrong file, shows in the effective value.
const UNREADABLE_VALUE = "12288";
const READABLE_VALUE = "8192";
const OVERRIDE_NAME = "artifacts.maxObjectBytes";
const CATALOG_VALUE = String(LIMIT_DEFINITION_BY_NAME[OVERRIDE_NAME]!.value);
// A ten-character value the screens compare only when a host limits file
// lowers secrets.configuredCredentialMinChars below the catalog's 12.
const SCREENED_VALUE = "qzxvbnmwrt";
const SCREEN_MIN_CHARS = "secrets.configuredCredentialMinChars";

const STACK_FRAME = /^\s+at .+:\d+:\d+\)?$/mu;
const WARNING_LINE = /^WARNING [a-z0-9-]+:/gmu;

async function fixtureFiles() {
  const root = await roots.create("docsfab-2003-files-");
  const unreadable = join(root, "unreadable-service.env");
  await writeFile(unreadable, `${OVERRIDE_NAME}=${UNREADABLE_VALUE}\n${SCREEN_MIN_CHARS}=8\n`);
  await chmod(unreadable, 0o000);
  const readable = join(root, "readable-service.env");
  await writeFile(readable, `${OVERRIDE_NAME}=${READABLE_VALUE}\n${SCREEN_MIN_CHARS}=8\n`);
  const empty = join(root, "empty-service.env");
  await writeFile(empty, "");
  const directory = join(root, "directory-service.env");
  await mkdir(directory);
  return { root, unreadable, readable, empty, directory, missing: join(root, "absent.env") };
}

/** Everything `action` writes to stderr, which it does not reach. */
function stderrOf(action: () => void): string[] {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    action();
  } finally {
    spy.mockRestore();
  }
  return written;
}

function skipNotice(path: string, reason: string): string {
  return `WARNING host-limits-file-unreadable: DocsFab cannot read the host limits file ${path} (${reason}), so it skips that file and the limit overrides it sets do not apply. ${HOST_LIMITS_FILE_REMEDIATION}`;
}

describe("host limits file read classification", () => {
  it("names who chose the host limits file, and reads the installed file only by default", () => {
    expect(resolveHostLimitFileSource(undefined, {})).toEqual({
      path: HOST_LIMITS_FILE,
      origin: "default",
    });
    expect(resolveHostLimitFileSource(undefined, { DOCSFAB_SERVICE_ENV_FILE: "/x.env" })).toEqual({
      path: "/x.env",
      origin: "variable",
    });
    expect(resolveHostLimitFileSource("/y.env", { DOCSFAB_SERVICE_ENV_FILE: "/x.env" })).toEqual({
      path: "/y.env",
      origin: "argument",
    });
    expect(resolveHostLimitFileSource(null, {})).toBeUndefined();
    expect(resolveHostLimitFileSource(undefined, { VITEST: "true" })).toBeUndefined();
  });

  it.skipIf(runsAsRoot)(
    "skips the installed default file this user cannot read, names it, and reports it once",
    async () => {
      const files = await fixtureFiles();
      let read: ReturnType<typeof readHostLimitFileAt> | undefined;
      const written = stderrOf(() => {
        read = readHostLimitFileAt({ path: files.unreadable, origin: "default" });
        readHostLimitFileAt({ path: files.unreadable, origin: "default" });
      });
      expect(read!.values.size).toBe(0);
      expect(read!.skipped).toEqual({
        code: HOST_LIMITS_FILE_UNREADABLE,
        path: files.unreadable,
        reason: "EACCES",
        remediation: HOST_LIMITS_FILE_REMEDIATION,
      });
      expect(written).toEqual([`${skipNotice(files.unreadable, "EACCES")}\n`]);
    },
  );

  it("reads a readable default file, skips nothing, and says nothing (positive control)", async () => {
    const files = await fixtureFiles();
    let read: ReturnType<typeof readHostLimitFileAt> | undefined;
    const written = stderrOf(() => {
      read = readHostLimitFileAt({ path: files.readable, origin: "default" });
    });
    expect(read!.skipped).toBeUndefined();
    expect(read!.values.get(OVERRIDE_NAME)).toBe(READABLE_VALUE);
    expect(written).toEqual([]);
  });

  it("does not repeat a file that a refusal already named, and still reports another", async () => {
    const files = await fixtureFiles();
    const written = stderrOf(() => {
      noteHostLimitFileRefused(files.directory);
      reportHostLimitFile(files.directory, "a refusal already named this file");
      reportHostLimitFile(files.empty, "this file was not named yet");
    });
    expect(written).toEqual(["WARNING host-limits-file-unreadable: this file was not named yet\n"]);
  });

  it.skipIf(runsAsRoot)(
    "refuses a file DOCSFAB_SERVICE_ENV_FILE names that this user cannot read",
    async () => {
      const files = await fixtureFiles();
      let caught: unknown;
      const written = stderrOf(() => {
        try {
          readHostLimitFile(undefined, { DOCSFAB_SERVICE_ENV_FILE: files.unreadable });
        } catch (error) {
          caught = error;
        }
      });
      expect(caught).toBeInstanceOf(HostLimitsFileError);
      expect(caught).toMatchObject({
        code: "host-limits-file-unreadable",
        path: files.unreadable,
        origin: "variable",
        reason: "EACCES",
      });
      expect((caught as Error).message).toBe(
        `DocsFab cannot read the host limits file ${files.unreadable} that DOCSFAB_SERVICE_ENV_FILE names (EACCES). ${HOST_LIMITS_FILE_REMEDIATION}`,
      );
      expect((caught as Error).message).not.toMatch(/group|chmod|permission/iu);
      // A refusal is not also a notice.
      expect(written).toEqual([]);
      // A path the caller names is no more skippable than the variable.
      expect(() => readHostLimitFile(files.unreadable, {})).toThrow(HostLimitsFileError);
    },
  );

  it("refuses a directory at the installed path with its code instead of skipping it", async () => {
    const files = await fixtureFiles();
    expect(() => readHostLimitFileAt({ path: files.directory, origin: "default" })).toThrow(
      expect.objectContaining({ code: "host-limits-file-unreadable", reason: "EISDIR" }),
    );
  });

  it("treats a missing file as setting nothing, whoever named it", async () => {
    const files = await fixtureFiles();
    const underAFile = join(files.readable, "service.env");
    for (const origin of ["default", "variable", "argument"] as const) {
      for (const path of [files.missing, underAFile]) {
        const read = readHostLimitFileAt({ path, origin });
        expect({ size: read.values.size, skipped: read.skipped }).toEqual({
          size: 0,
          skipped: undefined,
        });
      }
    }
  });

  it.skipIf(runsAsRoot)(
    "keeps the unreadable-file code when setup resolves its lock bounds",
    async () => {
      const files = await fixtureFiles();
      const configurationRoot = await roots.create("docsfab-2003-config-");
      expect(() =>
        resolveSecretsEnvLockLimits(
          { DOCSFAB_CONFIG_ROOT: configurationRoot, DOCSFAB_SERVICE_ENV_FILE: files.unreadable },
          configurationRoot,
        ),
      ).toThrow(expect.objectContaining({ code: "host-limits-file-unreadable" }));
    },
  );
});

interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A preload that sends reads of the installed host limits file to `target`,
 * or, with `failWith`, fails them with that error code.
 */
async function redirectInstalledFile(
  root: string,
  name: string,
  target: string,
  failWith?: string,
): Promise<string> {
  const preload = join(root, `redirect-${name}.mjs`);
  await writeFile(
    preload,
    [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      `const INSTALLED = ${JSON.stringify(HOST_LIMITS_FILE)};`,
      `const TARGET = ${JSON.stringify(target)};`,
      `const FAIL_WITH = ${JSON.stringify(failWith ?? null)};`,
      'for (const name of ["readFileSync", "existsSync", "statSync", "lstatSync", "openSync", "accessSync"]) {',
      "  const original = fs[name];",
      "  fs[name] = function redirected(path, ...rest) {",
      '    if (path === INSTALLED && FAIL_WITH && name === "readFileSync") {',
      '      throw Object.assign(new Error(FAIL_WITH + ": injected read failure"), { code: FAIL_WITH });',
      "    }",
      "    return original.call(this, path === INSTALLED ? TARGET : path, ...rest);",
      "  };",
      "}",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return preload;
}

const localCliCaseMs = 120_000;
const localCliProcessMs = 90_000;

/** Run Node in a fresh home and non-repository directory, with no test-runner variables. */
async function runNode(
  nodeArgs: readonly string[],
  options: {
    readonly preload?: string;
    readonly environment?: Record<string, string>;
    readonly configurationRoot?: boolean;
  } = {},
): Promise<ProcessResult> {
  const root = await roots.create("docsfab-2003-run-");
  const [home, config, cwd] = ["home", "config", "cwd"].map((name) => join(root, name));
  await Promise.all([home, config, cwd].map((path) => mkdir(path!)));
  await chmod(config!, 0o700);
  const args = [
    ...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []),
    ...nodeArgs,
  ];
  const deadline = nestedDeadlineMs(localCliProcessMs, localCliCaseMs);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      // No VITEST or NODE_TEST_CONTEXT, so the child resolves the installed default.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home!,
        NO_COLOR: "1",
        ...(options.configurationRoot === false ? {} : { DOCSFAB_CONFIG_ROOT: config! }),
        ...options.environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`node ${nodeArgs.join(" ")} exceeded ${deadline} ms`));
    }, deadline);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

/** Run the built CLI. */
function runCli(
  args: readonly string[],
  options: { readonly preload?: string; readonly environment?: Record<string, string> } = {},
): Promise<ProcessResult> {
  return runNode([BIN, ...args], options);
}

/**
 * Load only the configured-credential screens, as the host's tools do under
 * strip-types, register one ten-character value, and screen a text holding it.
 */
async function runScreens(
  root: string,
  options: { readonly preload?: string; readonly environment?: Record<string, string> } = {},
): Promise<ProcessResult & { readonly verdict: { status: string; found: boolean } }> {
  const script = join(root, "screen-one-text.mjs");
  await writeFile(
    script,
    [
      `import { containsConfiguredCredential, registerConfiguredCredential } from ${JSON.stringify(pathToFileURL(SCREENS).href)};`,
      `const status = registerConfiguredCredential(${JSON.stringify(SCREENED_VALUE)}, "test registration");`,
      `const found = containsConfiguredCredential(${JSON.stringify(`before ${SCREENED_VALUE} after`)});`,
      'process.stdout.write(JSON.stringify({ status, found }) + "\\n");',
      "",
    ].join("\n"),
  );
  const result = await runNode(["--no-warnings", "--experimental-strip-types", script], {
    ...options,
    configurationRoot: false,
  });
  expect(result.status, result.stderr).toBe(0);
  return { ...result, verdict: JSON.parse(result.stdout) as { status: string; found: boolean } };
}

function warningLines(result: ProcessResult): string[] {
  return [...(result.stderr.match(WARNING_LINE) ?? [])].sort();
}

function expectNoStackTrace(result: ProcessResult): void {
  expect(result.stderr).not.toMatch(STACK_FRAME);
  expect(result.stderr).not.toContain("node:internal");
  expect(result.stderr).not.toMatch(/^Error: /mu);
}

const SKIP_WARNING = skipNotice(HOST_LIMITS_FILE, "EACCES");
const SKIP_LINE = `Host limits file: skipped ${HOST_LIMITS_FILE} (host-limits-file-unreadable, EACCES). The limit overrides it sets do not apply. ${HOST_LIMITS_FILE_REMEDIATION}`;

function overrideRow(stdout: string): string | undefined {
  return stdout.split("\n").find((line) => line.startsWith(`${OVERRIDE_NAME} |`));
}

describe("bin/docsfab.mjs with an unreadable host limits file", {
  timeout: testTimeoutMs(localCliCaseMs),
}, () => {
  // One child first: a stale dist/ rebuilds once, not once per parallel child.
  beforeAll(async () => {
    const warm = await runCli(["--version"]);
    expect(warm.status).toBe(0);
  }, testTimeoutMs(localCliCaseMs));

  it.skipIf(runsAsRoot)(
    "runs list, doctor, and setup past an unreadable installed file with one coded notice and the usual exit status",
    async () => {
      const files = await fixtureFiles();
      const absent = await redirectInstalledFile(files.root, "absent", files.missing);
      const unreadable = await redirectInstalledFile(files.root, "unreadable", files.unreadable);
      // Setup with an installed composition reaches the secrets lock, which
      // reads the host limits file again.
      const commands = [
        ["list"],
        ["doctor"],
        ["setup", "--profile", "nvidia-inference-gpt-6-sol-pi"],
      ];
      const baseline = await Promise.all(commands.map((args) => runCli(args, { preload: absent })));
      const skipped = await Promise.all(
        commands.map((args) => runCli(args, { preload: unreadable })),
      );
      const quietDoctor = await runCli(["doctor", "--quiet"], { preload: unreadable });
      // The baseline is a working CLI, so equal exit statuses are not two crashes.
      expect(baseline[0]!.status).toBe(0);
      expect(baseline[0]!.stdout).toContain(
        "Plan review-documentation: 'docsfab' 'plan' 'review-documentation'",
      );
      for (const [index, args] of commands.entries()) {
        const before = baseline[index]!;
        const after = skipped[index]!;
        expectNoStackTrace(before);
        expect(before.stderr).not.toContain("host-limits-file-unreadable");
        expectNoStackTrace(after);
        expect({ command: args.join(" "), status: after.status }).toEqual({
          command: args.join(" "),
          status: before.status,
        });
        // One coded notice beyond what the no-file run warns, and no credential-screen echo.
        expect(warningLines(after)).toEqual(
          [...warningLines(before), "WARNING host-limits-file-unreadable:"].sort(),
        );
        expect(after.stderr).toContain(SKIP_WARNING);
      }
      expect(skipped[0]!.stdout).toBe(baseline[0]!.stdout);
      expect(skipped[1]!.stdout).toContain(SKIP_LINE);
      expect(baseline[1]!.stdout).not.toContain("Host limits file:");
      expectNoStackTrace(quietDoctor);
      expect(quietDoctor.stdout).toContain(SKIP_LINE);
    },
  );

  it.skipIf(runsAsRoot)(
    "names the skipped installed file above the doctor --limits table and in its JSON, and applies none of its values",
    async () => {
      const files = await fixtureFiles();
      const absent = await redirectInstalledFile(files.root, "absent", files.missing);
      const unreadable = await redirectInstalledFile(files.root, "unreadable", files.unreadable);
      const [baseline, human, json] = await Promise.all([
        runCli(["doctor", "--limits"], { preload: absent }),
        runCli(["doctor", "--limits"], { preload: unreadable }),
        runCli(["doctor", "--limits", "--json"], { preload: unreadable }),
      ]);
      for (const result of [baseline, human, json]) expectNoStackTrace(result);
      expect(human.status).toBe(baseline.status);
      expect(human.stdout.split("\n")[0]).toBe(SKIP_LINE);
      expect(human.stdout.split("\n")[1]).toBe(
        "name | value | unit | source | observed-max-seen | headroom% | status",
      );
      expect(overrideRow(human.stdout)).toBe(overrideRow(baseline.stdout));
      expect(overrideRow(human.stdout)).toMatch(
        new RegExp(
          `^artifacts\\.maxObjectBytes \\| ${CATALOG_VALUE} \\| bytes \\| config/limits\\.yaml \\|`,
          "u",
        ),
      );
      expect(baseline.stdout.split("\n")[0]).toBe(
        "name | value | unit | source | observed-max-seen | headroom% | status",
      );
      const report = JSON.parse(json.stdout) as Record<string, unknown>;
      expect(report.hostLimitsFile).toEqual({
        code: "host-limits-file-unreadable",
        path: HOST_LIMITS_FILE,
        reason: "EACCES",
        remediation: HOST_LIMITS_FILE_REMEDIATION,
      });
    },
  );

  it("applies a readable installed file through the same redirected default (positive control)", async () => {
    const files = await fixtureFiles();
    const readable = await redirectInstalledFile(files.root, "readable", files.readable);
    const result = await runCli(["doctor", "--limits", "--json"], { preload: readable });
    expectNoStackTrace(result);
    expect(result.stderr).not.toContain("host-limits-file-unreadable");
    const report = JSON.parse(result.stdout) as {
      readonly rows: readonly {
        readonly name: string;
        readonly value: number;
        readonly source: string;
      }[];
    };
    expect(report.rows.find((row) => row.name === OVERRIDE_NAME)).toMatchObject({
      value: Number(READABLE_VALUE),
      source: "host",
    });
    // A file that was read adds no key, so the service status projection keeps its exact shape.
    expect(Object.keys(report).sort()).toEqual([
      "exitCode",
      "kind",
      "rows",
      "schemaVersion",
      "status",
    ]);
  });

  it.skipIf(runsAsRoot)(
    "refuses an unreadable DOCSFAB_SERVICE_ENV_FILE with the coded envelope instead of a stack trace",
    async () => {
      const files = await fixtureFiles();
      const [refused, empty] = await Promise.all([
        runCli(["list"], { environment: { DOCSFAB_SERVICE_ENV_FILE: files.unreadable } }),
        // The documented workaround: an empty limits file the user owns.
        runCli(["list"], { environment: { DOCSFAB_SERVICE_ENV_FILE: files.empty } }),
      ]);
      expectNoStackTrace(refused);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(
        "unreadable-service.env that DOCSFAB_SERVICE_ENV_FILE names (EACCES)",
      );
      expect(refused.stderr).toMatch(/^code: host-limits-file-unreadable$/mu);
      expect(refused.stderr).toMatch(/^failure class: operator-input \(layer cli\)$/mu);
      expect(refused.stderr).toMatch(
        /^Next action: Set DOCSFAB_SERVICE_ENV_FILE to a limits file this user can read/mu,
      );
      // The envelope alone names the file: no notice and no credential-screen echo repeats it.
      expect(warningLines(refused)).toEqual([]);
      expectNoStackTrace(empty);
      expect(empty.status).toBe(0);
      expect(empty.stderr).toBe("");
    },
  );

  it("refuses a directory at the installed path with the coded envelope instead of a stack trace", async () => {
    const files = await fixtureFiles();
    const directory = await redirectInstalledFile(files.root, "directory", files.directory);
    const result = await runCli(["list"], { preload: directory });
    expectNoStackTrace(result);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `DocsFab cannot read the host limits file ${HOST_LIMITS_FILE} (EISDIR).`,
    );
    expect(result.stderr).toMatch(/^code: host-limits-file-unreadable$/mu);
    expect(warningLines(result)).toEqual([]);
  });
});

describe("operator reporter cold import with an unreadable host limits file", {
  timeout: testTimeoutMs(localCliCaseMs),
}, () => {
  const script = [
    `import { toOperatorErrorEnvelope } from ${JSON.stringify(pathToFileURL(REPORTER).href)};`,
    `import { readHostLimitFile } from ${JSON.stringify(pathToFileURL(join(RUNTIME_ROOT, "src", "config", "limit-resolution.js")).href)};`,
    'try { readHostLimitFile(undefined, process.env); process.stdout.write(JSON.stringify({status: "ready"}) + "\\n"); } catch (error) { process.stdout.write(JSON.stringify(toOperatorErrorEnvelope(error)) + "\\n"); }',
  ].join("\n");

  it.each(["explicit", "installed"] as const)(
    "loads the reporter and emits a coded envelope for an %s directory",
    async (origin) => {
      const files = await fixtureFiles();
      const preload =
        origin === "installed"
          ? await redirectInstalledFile(files.root, "reporter-directory", files.directory)
          : undefined;
      const result = await runNode(
        ["--import", pathToFileURL(TSX_LOADER).href, "--input-type=module", "-e", script],
        {
          ...(preload ? { preload } : {}),
          ...(origin === "explicit"
            ? { environment: { DOCSFAB_SERVICE_ENV_FILE: files.directory } }
            : {}),
        },
      );
      expectNoStackTrace(result);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "host-limits-file-unreadable",
        failure: { class: "operator-input", layer: "cli" },
      });
      expect(result.stdout).toContain(origin === "explicit" ? files.directory : HOST_LIMITS_FILE);
    },
  );

  it("loads the reporter with a readable explicit file", async () => {
    const files = await fixtureFiles();
    const result = await runNode(
      ["--import", pathToFileURL(TSX_LOADER).href, "--input-type=module", "-e", script],
      { environment: { DOCSFAB_SERVICE_ENV_FILE: files.readable } },
    );
    expectNoStackTrace(result);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "ready" });
  });
});

describe("configured-credential screens in a process without the limit loader", {
  timeout: testTimeoutMs(localCliCaseMs),
}, () => {
  it.skipIf(runsAsRoot)(
    "reports an unreadable installed file once and screens with the catalog bounds",
    async () => {
      const files = await fixtureFiles();
      const unreadable = await redirectInstalledFile(files.root, "unreadable", files.unreadable);
      const result = await runScreens(files.root, { preload: unreadable });
      expectNoStackTrace(result);
      expect(warningLines(result)).toEqual(["WARNING host-limits-file-unreadable:"]);
      expect(result.stderr).toContain(SKIP_WARNING);
      expect(result.verdict).toEqual({ status: "shorter-than-minimum", found: false });
    },
  );

  it("applies a readable installed file's screen bound through the same redirect (positive control)", async () => {
    const files = await fixtureFiles();
    const readable = await redirectInstalledFile(files.root, "readable", files.readable);
    const result = await runScreens(files.root, { preload: readable });
    expectNoStackTrace(result);
    expect(warningLines(result)).toEqual([]);
    expect(result.verdict).toEqual({ status: "screened", found: true });
  });

  it("skips an installed file the process may not read with EPERM and names EPERM", async () => {
    const files = await fixtureFiles();
    const denied = await redirectInstalledFile(files.root, "eperm", files.readable, "EPERM");
    const result = await runScreens(files.root, { preload: denied });
    expectNoStackTrace(result);
    expect(warningLines(result)).toEqual(["WARNING host-limits-file-unreadable:"]);
    expect(result.stderr).toContain(skipNotice(HOST_LIMITS_FILE, "EPERM"));
    expect(result.verdict).toEqual({ status: "shorter-than-minimum", found: false });
  });

  it.skipIf(runsAsRoot)(
    "reports a named file it cannot read with the shared coded notice, not an invalid-bound warning",
    async () => {
      const files = await fixtureFiles();
      const result = await runScreens(files.root, {
        environment: { DOCSFAB_SERVICE_ENV_FILE: files.unreadable },
      });
      expectNoStackTrace(result);
      expect(warningLines(result)).toEqual(["WARNING host-limits-file-unreadable:"]);
      expect(result.stderr).toContain(
        `WARNING host-limits-file-unreadable: DocsFab cannot read the host limits file ${files.unreadable} that DOCSFAB_SERVICE_ENV_FILE names (EACCES). ${HOST_LIMITS_FILE_REMEDIATION} The configured-credential screens use the override variables alone until it is corrected.`,
      );
      expect(result.verdict).toEqual({ status: "shorter-than-minimum", found: false });
    },
  );
});
