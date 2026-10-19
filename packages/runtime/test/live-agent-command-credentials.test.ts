// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  type TestContext,
  vi,
} from "vitest";
import { failureReason } from "../src/live-agent/activity-renderer.js";
import { CONFIGURATION_CREDENTIALS_FAILURE } from "../src/live-agent/command-sandbox.js";
import { createLiveCommandTool, LIVE_COMMAND_FAILURES } from "../src/live-agent/command-tool.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

/**
 * Approved live-agent commands run in the real platform sandbox here:
 * `sandbox-exec` on macOS, and `bwrap` on Linux where user namespaces work.
 */
const roots = temporaryRoots();
// Each case builds a repository and runs real sandboxed commands.
const CASE_MS = testTimeoutMs(30_000);

/** Why this host cannot run the documentation command sandbox, or undefined when it can. */
let unavailable: string | undefined;
beforeAll(async () => {
  unavailable = await sandboxUnavailable();
});

async function sandboxUnavailable(): Promise<string | undefined> {
  if (process.platform === "darwin") return undefined;
  if (process.platform !== "linux")
    return `${process.platform} has no documentation command sandbox`;
  try {
    // The namespace and mounts every documentation command sandbox starts with.
    await promisify(execFile)("/usr/bin/bwrap", [
      "--die-with-parent",
      "--unshare-pid",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "true",
    ]);
    return undefined;
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || String(error);
    return `bubblewrap with user namespaces is unavailable on this host: ${detail}`;
  }
}

function requireSandbox(context: TestContext): void {
  if (unavailable) context.skip(unavailable);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../src/config/host-paths.js");
  vi.resetModules();
});

/** Every name DocsFab gives a credential file in its configuration root, by label. */
const CREDENTIAL_FILES = {
  split: "secrets.env",
  legacy: ".env",
  migrated: ".env.legacy",
  backup: "secrets.env.4242.0f6c3e9a-1b2d-4c5e-8f70-a1b2c3d4e5f6.bak",
  temporary: ".env.legacy.4242.0f6c3e9a-1b2d-4c5e-8f70-a1b2c3d4e5f6.tmp",
  // An upper-case name on disk, which a case-insensitive file system also opens as secrets.env.
  kept: "SECRETS.ENV.setup-incomplete.0f6c3e9a-1b2d-4c5e-8f70-a1b2c3d4e5f6.bak",
} as const;
/** Configuration-root files that hold no credential and stay readable. */
const HOST_CONFIGURATION = "# fixture host configuration\n";
const TEMPLATE = "# fixture template, not a credential\n";

/** A configuration root holding each credential file name, plus files that stay readable. */
async function configurationRoot(path: string, layout: "split" | "legacy" = "split") {
  await mkdir(path, { recursive: true });
  await chmod(path, 0o700);
  const names: readonly string[] =
    layout === "split" ? Object.values(CREDENTIAL_FILES) : [CREDENTIAL_FILES.legacy];
  for (const name of names) await writeFile(join(path, name), `fixture ${name}\n`, { mode: 0o600 });
  if (layout === "split") await writeFile(join(path, "host.yaml"), HOST_CONFIGURATION);
  await writeFile(join(path, ".env.example"), TEMPLATE);
  return path;
}

async function repository(path: string, files: Record<string, string> = {}) {
  await initFixtureRepo(
    path,
    { "docs/guide.md": "Guide.\n", "src/app.js": "source\n", ...files },
    { branch: "topic" },
  );
  return path;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** One line per labelled path: whether `cat`, `test -r`, and `wc -c` could read it. Never its bytes. */
function readProbe(paths: Readonly<Record<string, string>>): string {
  return Object.entries(paths)
    .map(([label, path]) => {
      const file = quote(path);
      return `if cat ${file} >/dev/null 2>&1; then c=read; else c=denied; fi; if test -r ${file}; then r=readable; else r=unreadable; fi; if w=$(wc -c 2>/dev/null < ${file}); then w=$((w)); else w=denied; fi; echo "${label} cat=$c test-r=$r wc=$w"`;
    })
    .join("\n");
}
const hidden = (label: string) => `${label} cat=denied test-r=unreadable wc=denied`;
const readable = (label: string, bytes: string) =>
  `${label} cat=read test-r=readable wc=${Buffer.byteLength(bytes)}`;

/** Positive controls: documentation stays writable, the checkout readable, and no API key is inherited. */
const CONTROLS = [
  "if printf 'probe\\n' > docs/probe.md; then echo docs=writable; else echo docs=blocked; fi",
  "if cat src/app.js >/dev/null; then echo repository=readable; else echo repository=blocked; fi",
  'echo "api-key-variables=$(env | grep -ci api_key)"',
].join("\n");
const CONTROLS_PASS = ["docs=writable", "repository=readable", "api-key-variables=0"];

async function approved(
  repositoryPath: string,
  environment: NodeJS.ProcessEnv,
  command: string,
  create = createLiveCommandTool,
) {
  const tool = create({
    repositoryPath,
    allowWrite: true,
    confirm: async () => true,
    // The session holds model keys; the command must not inherit them.
    environment: {
      PATH: process.env.PATH,
      MODEL_API_KEY: "unused",
      OPENAI_API_KEY: "unused",
      ...environment,
    },
  });
  return tool.execute("call", { command, timeout: 60 }, undefined, undefined, {} as never);
}

/** The command's output lines after the exit line, which must report success. */
async function succeeded(result: ReturnType<typeof approved>): Promise<string[]> {
  const { content, details } = await result;
  const [exit, ...lines] = (content[0] as { text: string }).text.split("\n");
  expect(exit).toBe("Command exited with code 0.");
  expect(details).toMatchObject({ status: "succeeded", exitCode: 0 });
  return lines.filter((line) => line !== "");
}

describe("approved live-agent commands and DocsFab's own credential files", {
  timeout: CASE_MS,
}, () => {
  it("hides secrets.env, the legacy .env, and their copies, while other files keep normal access", async (context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"));
    const configuration = await configurationRoot(join(base, "config"));
    const credentials = Object.fromEntries(
      Object.entries(CREDENTIAL_FILES).map(([label, name]) => [label, join(configuration, name)]),
    );
    const lines = await succeeded(
      approved(
        checkout,
        { HOME: base, DOCSFAB_CONFIG_ROOT: configuration },
        [
          readProbe({
            ...credentials,
            // The same file under another spelling; on Linux, a name that does not exist.
            "split-upper-case": join(configuration, "SECRETS.ENV"),
            host: join(configuration, "host.yaml"),
            template: join(configuration, ".env.example"),
          }),
          CONTROLS,
        ].join("\n"),
      ),
    );
    expect(lines).toEqual([
      ...Object.keys(CREDENTIAL_FILES).map(hidden),
      hidden("split-upper-case"),
      readable("host", HOST_CONFIGURATION),
      readable("template", TEMPLATE),
      ...CONTROLS_PASS,
    ]);
    expect(await readFile(join(checkout, "docs", "probe.md"), "utf8")).toBe("probe\n");
  });

  it("hides the legacy .env that a legacy configuration root uses", async (context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"));
    const configuration = await configurationRoot(join(base, "config"), "legacy");
    const lines = await succeeded(
      approved(
        checkout,
        { HOME: base, DOCSFAB_CONFIG_ROOT: configuration },
        [
          readProbe({
            legacy: join(configuration, ".env"),
            template: join(configuration, ".env.example"),
          }),
          CONTROLS,
        ].join("\n"),
      ),
    );
    expect(lines).toEqual([hidden("legacy"), readable("template", TEMPLATE), ...CONTROLS_PASS]);
  });

  it("follows a symlinked configuration root and a symlinked secrets.env to the files they name", async (context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"));
    const real = join(base, "real-config");
    const keys = join(base, "keys");
    await mkdir(real);
    await chmod(real, 0o700);
    await mkdir(keys);
    await writeFile(join(keys, "docsfab.env"), "fixture outside the root\n");
    await symlink(join(keys, "docsfab.env"), join(real, "secrets.env"));
    await writeFile(join(real, ".env"), "fixture legacy\n");
    const linked = join(base, "linked-config");
    await symlink(real, linked);
    const lines = await succeeded(
      approved(
        checkout,
        { HOME: base, DOCSFAB_CONFIG_ROOT: linked },
        [
          readProbe({
            "linked-split": join(linked, "secrets.env"),
            "linked-legacy": join(linked, ".env"),
            "real-legacy": join(real, ".env"),
            target: join(keys, "docsfab.env"),
          }),
          CONTROLS,
        ].join("\n"),
      ),
    );
    expect(lines).toEqual([
      hidden("linked-split"),
      hidden("linked-legacy"),
      hidden("real-legacy"),
      hidden("target"),
      ...CONTROLS_PASS,
    ]);
  });

  it("hides the credential files of a configuration root that holds the repository", async (context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const configuration = await configurationRoot(join(base, "config"));
    const checkout = await repository(join(configuration, "repo"));
    const lines = await succeeded(
      approved(
        checkout,
        { HOME: base, DOCSFAB_CONFIG_ROOT: configuration },
        [
          readProbe({
            split: join(configuration, "secrets.env"),
            legacy: join(configuration, ".env"),
            host: join(configuration, "host.yaml"),
          }),
          CONTROLS,
        ].join("\n"),
      ),
    );
    expect(lines).toEqual([
      hidden("split"),
      hidden("legacy"),
      readable("host", HOST_CONFIGURATION),
      ...CONTROLS_PASS,
    ]);
  });

  it("hides the credential file of a configuration root inside the repository and keeps Git working", async (context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"), {
      "packages/tool/.env.example": TEMPLATE,
    });
    const configuration = join(checkout, "packages", "tool");
    await chmod(configuration, 0o700);
    await writeFile(join(configuration, ".env"), "fixture legacy\n", { mode: 0o600 });
    const status = await git(checkout, ["status", "--porcelain=v1"]);
    const lines = await succeeded(
      approved(
        checkout,
        { HOME: base, DOCSFAB_CONFIG_ROOT: configuration },
        [
          readProbe({
            legacy: join(configuration, ".env"),
            template: join(configuration, ".env.example"),
          }),
          'git status --porcelain=v1 > "$TMPDIR/status" && echo git=ok',
          "if git diff --quiet; then echo tracked=unchanged; else echo tracked=changed; fi",
          CONTROLS,
        ].join("\n"),
      ),
    );
    expect(lines).toEqual([
      hidden("legacy"),
      readable("template", TEMPLATE),
      "git=ok",
      "tracked=unchanged",
      ...CONTROLS_PASS,
    ]);
    expect((await git(checkout, ["status", "--porcelain=v1"])).split("\n")).toEqual(
      [...status.split("\n"), "?? docs/probe.md"].sort(),
    );
  });

  it("keeps a credential file hidden and unchanged under a writable documentation directory", async (context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"));
    const configuration = join(checkout, "docs", "config");
    await mkdir(configuration);
    await chmod(configuration, 0o700);
    await writeFile(join(configuration, "secrets.env"), "fixture split\n", { mode: 0o600 });
    const lines = await succeeded(
      approved(
        checkout,
        { HOME: base, DOCSFAB_CONFIG_ROOT: configuration },
        [
          readProbe({ split: join(configuration, "secrets.env") }),
          "if printf 'replaced\\n' 2>/dev/null > docs/config/secrets.env; then echo credential=written; else echo credential=protected; fi",
          CONTROLS,
        ].join("\n"),
      ),
    );
    expect(lines).toEqual([hidden("split"), "credential=protected", ...CONTROLS_PASS]);
    expect(await readFile(join(configuration, "secrets.env"), "utf8")).toBe("fixture split\n");
  });

  it("hides the files of the configuration root DocsFab loaded when the session names none", async (context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"));
    const configuration = await configurationRoot(join(base, "config"));
    // `loadConfig` reads the process environment beneath the session's.
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", configuration);
    const lines = await succeeded(
      approved(
        checkout,
        { HOME: base },
        [readProbe({ split: join(configuration, "secrets.env") }), CONTROLS].join("\n"),
      ),
    );
    expect(lines).toEqual([hidden("split"), ...CONTROLS_PASS]);
  });

  it("hides the files of the default configuration root under the home directory", async (context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"));
    const configuration = await configurationRoot(join(base, "home", ".config", "docsfab"));
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", undefined);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.stubEnv("HOME", join(base, "home"));
    const lines = await succeeded(
      approved(
        checkout,
        { HOME: join(base, "home") },
        [readProbe({ split: join(configuration, "secrets.env") }), CONTROLS].join("\n"),
      ),
    );
    expect(lines).toEqual([hidden("split"), ...CONTROLS_PASS]);
  });

  it("hides the secrets file in effect when it lies outside the configuration root", async (context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"));
    const installed = join(base, "installed", ".env");
    await mkdir(dirname(installed));
    await writeFile(installed, "fixture installed package\n", { mode: 0o600 });
    // The installed-package fallback, which applies only to a root with no configuration files.
    vi.doMock("../src/config/host-paths.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/config/host-paths.js")>()),
      describeDocsFabConfigurationSource: () => ({
        configurationRoot: join(base, "config"),
        layout: "checkout-legacy",
        secretsFile: installed,
      }),
    }));
    vi.resetModules();
    const { createLiveCommandTool: create } = await import("../src/live-agent/command-tool.js");
    const lines = await succeeded(
      approved(checkout, { HOME: base }, [readProbe({ installed }), CONTROLS].join("\n"), create),
    );
    expect(lines).toEqual([hidden("installed"), ...CONTROLS_PASS]);
  });

  type Prepare = (base: string, configuration: string) => Promise<string>;
  it.for<[string, Prepare]>([
    ["no configuration root exists", async (_base, configuration) => configuration],
    [
      "secrets.env is a link to nothing",
      async (base, configuration) => {
        await mkdir(configuration);
        await chmod(configuration, 0o700);
        await symlink(join(base, "missing.env"), join(configuration, "secrets.env"));
        return configuration;
      },
    ],
  ])("runs the command when %s", async ([, prepare], context) => {
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"));
    const configuration = await prepare(base, join(base, "config"));
    const lines = await succeeded(
      approved(checkout, { HOME: base, DOCSFAB_CONFIG_ROOT: configuration }, CONTROLS),
    );
    expect(lines).toEqual(CONTROLS_PASS);
  });

  type Refused = (configuration: string, context: TestContext) => Promise<string>;
  it.for<[string, Refused]>([
    ["cannot be resolved", async () => "relative/config"],
    [
      "cannot be listed",
      async (configuration, context) => {
        // The owner of the directory cannot list it; root can, so the case does not apply.
        if (process.getuid?.() === 0) context.skip("root can list any directory");
        await mkdir(configuration);
        await writeFile(join(configuration, "secrets.env"), "fixture split\n", { mode: 0o600 });
        await chmod(configuration, 0o300);
        return configuration;
      },
    ],
    [
      "holds a credential link that loops",
      async (configuration) => {
        await mkdir(configuration);
        await chmod(configuration, 0o700);
        await symlink("secrets.env", join(configuration, "secrets.env"));
        return configuration;
      },
    ],
  ])(
    "refuses with a coded next action, and runs nothing, when the configuration root %s",
    async ([, prepare], context) => {
      requireSandbox(context);
      const base = await roots.create("docsfab-command-credentials-");
      const checkout = await repository(join(base, "repo"));
      const configuration = await prepare(join(base, "config"), context);
      const refusal = await approved(
        checkout,
        { HOME: base, DOCSFAB_CONFIG_ROOT: configuration },
        "printf 'ran\\n' > docs/refused.md",
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      // Teardown removes the fixture before onTestFinished runs, so list access returns here.
      await chmod(join(base, "config"), 0o700).catch(() => undefined);
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toBe(LIVE_COMMAND_FAILURES.configurationUnreadable);
      expect(LIVE_COMMAND_FAILURES.configurationUnreadable).toBe(CONFIGURATION_CREDENTIALS_FAILURE);
      expect(CONFIGURATION_CREDENTIALS_FAILURE).toMatch(
        /\(live-command-configuration-unreadable\).*No command ran\. Next action: /u,
      );
      // The terminal shows this fixed refusal verbatim, as it shows no unlisted message.
      expect(failureReason(refusal, [])).toBe(CONFIGURATION_CREDENTIALS_FAILURE);
      await expect(readFile(join(checkout, "docs", "refused.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("gives the command its own PID namespace, so no host process's environment or command line is readable", async (context) => {
    if (process.platform !== "linux")
      context.skip("Linux only: macOS commands share the host process table");
    requireSandbox(context);
    const base = await roots.create("docsfab-command-credentials-");
    const checkout = await repository(join(base, "repo"));
    // A host process standing in for DocsFab, started with fixture values in its environment and arguments.
    const helper = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready'); process.stdin.resume()", "fixture-argument-2006"],
      {
        env: { PATH: process.env.PATH, PROBE_FIXTURE: "fixture-environment-2006" },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    onTestFinished(() => {
      helper.kill("SIGKILL");
    });
    await new Promise((resolve) => helper.stdout.once("data", resolve));
    // The scan reads every command line and environment in the sandbox, so none may hold a sentinel
    // (#2082). The command text is bash's own command line, so each sentinel is assembled inside the
    // command. A grep argument would sit in grep's own /proc/<pid>/cmdline, which the scan reads once
    // grep has started and then counts, so grep takes its patterns from a file in the private TMPDIR.
    const sentinels = `printf '%s%s\\n%s%s\\n' fixture-environment- 2006 fixture-argument- 2006 > "$TMPDIR/sentinels"`;
    const grepSentinels = `grep -c -F -f "$TMPDIR/sentinels"`;
    const scan = (files: string) =>
      `$(cat ${files} 2>/dev/null | tr '\\0' '\\n' | ${grepSentinels})`;
    const lines = await succeeded(
      approved(
        checkout,
        { HOME: base, DOCSFAB_CONFIG_ROOT: join(base, "config") },
        [
          `if test -e /proc/${process.pid}; then echo docsfab-process=visible; else echo docsfab-process=hidden; fi`,
          `if test -e /proc/${helper.pid}; then echo host-process=visible; else echo host-process=hidden; fi`,
          sentinels,
          `echo "environ-matches=${scan("/proc/[0-9]*/environ")}"`,
          `echo "cmdline-matches=${scan("/proc/[0-9]*/cmdline")}"`,
          // Positive controls: the sandbox's own /proc is mounted and readable; the same scan counts
          // both sentinels in NUL-separated data, as a command line or environment holds them; and
          // the grep of that scan holds neither sentinel in its own command line.
          "if grep -q bash /proc/$$/cmdline; then echo own-proc=readable; else echo own-proc=unreadable; fi",
          `printf 'a\\0%s%s\\0b\\0%s%s\\0' fixture-environment- 2006 fixture-argument- 2006 > "$TMPDIR/record"`,
          `echo "record-matches=${scan('"$TMPDIR/record"')}"`,
          `echo "grep-argv-matches=$(${grepSentinels} /proc/self/cmdline)"`,
        ].join("\n"),
      ),
    );
    expect(lines).toEqual([
      "docsfab-process=hidden",
      "host-process=hidden",
      "environ-matches=0",
      "cmdline-matches=0",
      "own-proc=readable",
      "record-matches=2",
      "grep-argv-matches=0",
    ]);
  });
});
