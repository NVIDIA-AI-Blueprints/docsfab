// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Linux required-check bubblewrap argv golden. The launcher and filesystem
 * presence probes are replaced with a fixed host shape, so the exact argv and
 * environment `prepareCheckSandbox` hands to `/usr/bin/bwrap` on Linux is
 * captured on any host.
 */
const launches: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> =
  [];
const present = new Set<string>();
/** A fixed runtime install, so the golden does not depend on where this host keeps node. */
const GOLDEN_NODE = "/opt/docsfab-golden-runtime/bin/node";
const listings = new Map<string, Array<{ name: string; directory: boolean }>>();
/** Directories whose listing fails, as an unreadable checkout directory would. */
const unreadable = new Set<string>();
/** What the mocked bubblewrap prints; anything but "ready" fails the readiness probe. */
let bubblewrapOutput = "ready";
/** Runs against each mocked bubblewrap launch's environment before it answers. */
let onLaunch: ((env: Record<string, string>) => void) | undefined;
/**
 * Behaviors for the next launches, in order; an empty queue prints
 * `bubblewrapOutput` and exits 0. `hang` never exits on its own.
 */
type MockChild = "hang" | { readonly chunks: readonly Buffer[]; readonly code: number };
const nextChildren: MockChild[] = [];
/** Git commands that present metadata; they run for real, on this host. */
const gitLaunches: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> =
  [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((executable: string, args: string[], options: Record<string, unknown>) => {
      if (executable === "/usr/bin/git") {
        gitLaunches.push({ executable, args: [...args], options });
        return actual.spawn(executable, args, options as never);
      }
      launches.push({ executable, args: [...args], options });
      onLaunch?.(options.env as Record<string, string>);
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        unref: () => undefined,
      });
      const behavior = nextChildren.shift();
      if (behavior === "hang") return child;
      setImmediate(() => {
        if (behavior) {
          for (const chunk of behavior.chunks) child.stdout.write(chunk);
          child.stdout.end();
        } else {
          child.stdout.end(bubblewrapOutput);
        }
        child.stderr.end();
        setImmediate(() => child.emit("close", behavior ? behavior.code : 0));
      });
      return child;
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(async (path: string) =>
      path === process.execPath ? GOLDEN_NODE : actual.realpath(path),
    ),
    access: vi.fn(async (path: string) => {
      if (!present.has(path)) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    }),
    readdir: vi.fn(async (path: string, options?: unknown) => {
      if (unreadable.has(path)) throw Object.assign(new Error("denied"), { code: "EACCES" });
      const listing = listings.get(path);
      if (!listing) return actual.readdir(path, options as never);
      return listing.map(({ name, directory }) => ({
        name,
        isDirectory: () => directory,
      }));
    }),
  };
});

const {
  checkSandboxBubblewrapArgs,
  checkSandboxEnvironment,
  checkSandboxReadRoots,
  prepareCheckSandbox,
} = await import("../src/workflow-execution/check-sandbox.js");
const { hostSelectedCheckAuthority } = await import("../src/workflow-execution/workflow-checks.js");
const { credentialFreeGitEnvironment, SAFE_GIT_CONFIG } = await import(
  "../src/repository/evidence.js"
);
const { requiredCheckIsolationRemedy } = await import(
  "../src/workflow-execution/check-isolation-selection.js"
);

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "check-sandbox-linux-bubblewrap.golden.json",
);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  bubblewrapOutput = "ready";
  onLaunch = undefined;
  nextChildren.splice(0);
  vi.useRealTimers();
  launches.splice(0);
  gitLaunches.splice(0);
  present.clear();
  listings.clear();
  unreadable.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Replace host-specific roots with stable placeholders, longest first. */
function normalize(value: unknown, roots: ReadonlyArray<readonly [string, string]>): unknown {
  const ordered = [...roots].sort((left, right) => right[0].length - left[0].length);
  return JSON.parse(
    ordered.reduce((text, [path, token]) => text.split(path).join(token), JSON.stringify(value)),
  );
}

describe("required-check Linux bubblewrap golden", () => {
  it("keeps the probe and check argv and environment byte for byte", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-golden-repo-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const runtime = dirname(dirname(GOLDEN_NODE));
    for (const path of [
      "/usr/bin/bwrap",
      "/bin",
      "/lib",
      "/usr/bin",
      "/usr/lib",
      "/usr/share",
      "/usr/local/bin",
      join(runtime, "bin"),
      join(runtime, "lib"),
      root,
    ])
      present.add(path);
    listings.set(root, [
      { name: "docs", directory: true },
      { name: ".env", directory: false },
      { name: ".git", directory: true },
      { name: "keys.md", directory: false },
      { name: ".gitignore", directory: false },
    ]);
    listings.set(join(root, "docs"), [
      { name: ".npmrc", directory: false },
      { name: "guide.md", directory: false },
      { name: "id_rsa.pub", directory: false },
      { name: ".config", directory: true },
    ]);

    const sandbox = await prepareCheckSandbox(root);
    expect(launches).toHaveLength(1);
    const scratch = String((launches[0]!.options.env as Record<string, string>).HOME);
    cleanups.push(() => rm(scratch, { recursive: true, force: true }));
    expect(sandbox).toMatchObject({ node: GOLDEN_NODE, runtime });
    // The checkout's own `.git` stays masked, so DocsFab presents no metadata over it.
    expect(sandbox.gitMetadata).toBe(false);
    const result = await sandbox.run("/usr/bin/python3", ["-m", "unittest", "discover"], {
      cwd: join(root, "docs"),
    });
    expect(result).toEqual({ status: "passed", exitCode: 0, output: "ready" });

    const captured = normalize(
      {
        launches: launches.map(({ executable, args, options }) => ({
          executable,
          args,
          cwd: options.cwd,
          detached: options.detached,
          stdio: options.stdio,
          env: options.env,
        })),
      },
      [
        [scratch, "<SCRATCH>"],
        [root, "<ROOT>"],
      ],
    );
    expect(captured).toEqual(JSON.parse(await readFile(GOLDEN, "utf8")));
  });

  it("builds the same argv and environment from injected host paths", async () => {
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as {
      launches: Array<{ args: string[]; env: Record<string, string> }>;
    };
    const check = golden.launches[1]!;
    const runtime = dirname(dirname(GOLDEN_NODE));
    const hosted = new Set([
      "/bin",
      "/lib",
      "/usr/bin",
      "/usr/lib",
      "/usr/share",
      "/usr/local/bin",
      join(runtime, "bin"),
      join(runtime, "lib"),
      "<ROOT>",
    ]);
    const args = checkSandboxBubblewrapArgs({
      mountedReadRoots: checkSandboxReadRoots("<ROOT>", runtime).filter((path) => hosted.has(path)),
      scratch: "<SCRATCH>",
      hidden: [
        { path: "<ROOT>/.env", directory: false },
        { path: "<ROOT>/.git", directory: true },
        { path: "<ROOT>/docs/.npmrc", directory: false },
        { path: "<ROOT>/docs/id_rsa.pub", directory: false },
        { path: "<ROOT>/docs/.config", directory: true },
      ],
    });
    expect(args).toEqual(check.args.slice(0, check.args.indexOf("--chdir")));
    expect(checkSandboxEnvironment(GOLDEN_NODE, "<SCRATCH>")).toEqual(check.env);
  });

  it("puts /usr/local/bin on PATH, and only mounted read roots (#1918)", () => {
    const runtime = dirname(dirname(GOLDEN_NODE));
    const roots = checkSandboxReadRoots("<ROOT>", runtime);
    const path = String(checkSandboxEnvironment(GOLDEN_NODE, "<SCRATCH>").PATH).split(":");
    // A tool installed in /usr/local/bin is found as it is outside the sandbox.
    expect(path).toContain("/usr/local/bin");
    expect(path.indexOf("/usr/local/bin")).toBeLessThan(path.indexOf("/usr/bin"));
    for (const entry of path) expect(roots, entry).toContain(entry);
  });
});

/**
 * Only a bubblewrap fault may be reported as one. These drive the shipped
 * default authority (`hostSelectedCheckAuthority` with the real
 * `prepareCheckSandbox`) on a Linux host shape where `/usr/bin/bwrap` exists.
 */
describe("required-check Linux refusal attribution", () => {
  async function linuxRepository() {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-attribution-repo-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const path of ["/usr/bin/bwrap", "/usr/bin", root]) present.add(path);
    return root;
  }

  async function refusalOf(root: string) {
    const error = await hostSelectedCheckAuthority(root).then(
      () => undefined,
      (failure: unknown) => failure as { name?: string; refusal?: string; message?: string },
    );
    expect(error).toMatchObject({ name: "CheckIsolationUnavailableError" });
    return { refusal: error?.refusal, remedy: requiredCheckIsolationRemedy([error?.refusal]) };
  }

  it.each([
    [
      "an unwritable host temporary directory",
      async (_root: string) => {
        vi.stubEnv("TMPDIR", join(tmpdir(), "docsfab-missing-tmpdir", "nested"));
      },
    ],
    [
      "an unreadable repository directory",
      async (root: string) => {
        unreadable.add(root);
      },
    ],
  ])("does not blame bubblewrap for %s", async (_name, arrange) => {
    const root = await linuxRepository();
    await arrange(root);
    const { refusal, remedy } = await refusalOf(root);
    expect(refusal).toBe("linux-check-preparation-failed");
    expect(remedy).toContain("bubblewrap is not the cause");
    expect(remedy).not.toContain("/usr/bin/bwrap");
    // Nothing ran: not the readiness probe, and not a repository command.
    expect(launches).toEqual([]);
  });

  it("prepares a checkout at the declared credential-scan bound, and codes a scan one entry past the bound (#1932)", async () => {
    // checks.credentialScanMaxEntries, lowered so the walk is small.
    vi.stubEnv("DOCSFAB_CHECKS_CREDENTIAL_SCAN_MAX_ENTRIES", "4");
    const pages = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ name: `page-${index}.md`, directory: false }));
    const atLimit = await linuxRepository();
    listings.set(atLimit, pages(4));
    const sandbox = await prepareCheckSandbox(atLimit);
    cleanups.push(sandbox.cleanup);
    // At the limit the scan completes, and only the readiness probe launches.
    expect(launches).toHaveLength(1);

    launches.splice(0);
    const overLimit = await linuxRepository();
    listings.set(overLimit, pages(5));
    const refused = await hostSelectedCheckAuthority(overLimit).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    // The declared code, the entry the scan stopped at, and the remediation; no
    // isolation refusal, and nothing launched beside an unscanned file.
    expect(refused).toMatchObject({
      name: "CheckSandboxLimitationError",
      cause: "credential-scan-bound",
      message: expect.stringMatching(
        /^checks-credential-scan-max-entries-bound: 5 exceeds checks\.credentialScanMaxEntries = 4 count\. .*DOCSFAB_CHECKS_CREDENTIAL_SCAN_MAX_ENTRIES/u,
      ),
    });
    expect(refused).not.toHaveProperty("refusal");
    expect(launches).toEqual([]);
  });

  it("does not blame bubblewrap for a repository path that cannot be resolved", async () => {
    const root = await linuxRepository();
    const { refusal } = await refusalOf(join(root, "missing-checkout"));
    expect(refusal).toBe("linux-check-preparation-failed");
    expect(launches).toEqual([]);
  });

  it.each([
    ["an absent /usr/bin/bwrap", () => present.delete("/usr/bin/bwrap"), 0],
    [
      "a failed readiness probe",
      () => {
        bubblewrapOutput = "bwrap: No permissions to create new namespace";
      },
      1,
    ],
  ])("names the bubblewrap remedy for %s", async (_name, arrange, probes) => {
    const root = await linuxRepository();
    arrange();
    const { refusal, remedy } = await refusalOf(root);
    expect(refusal).toBe("linux-bubblewrap-unavailable");
    expect(remedy).toContain("provide Linux bubblewrap at /usr/bin/bwrap");
    expect(launches).toHaveLength(probes);
  });

  it("establishes the sandbox when bubblewrap and the host inputs are ready", async () => {
    const root = await linuxRepository();
    const authority = await hostSelectedCheckAuthority(root);
    const scratch = String((launches[0]!.options.env as Record<string, string>).HOME);
    cleanups.push(() => rm(scratch, { recursive: true, force: true }));
    expect(launches).toHaveLength(1);
    expect(authority).toHaveProperty("run");
  });
});

/**
 * The declared check bounds and pre-flight on the production seam,
 * `prepareCheckSandbox().run` and `.resolveExecutable`, on any platform
 * (#1918, #1932). The launcher is the mocked bubblewrap above.
 */
describe("check sandbox production seam", () => {
  /** A Linux host shape whose checkout listing holds a `.git`, so no metadata is presented. */
  async function preparedSandbox() {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-seam-repo-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const path of ["/usr/bin/bwrap", "/usr/bin", root]) present.add(path);
    listings.set(root, [{ name: ".git", directory: true }]);
    const sandbox = await prepareCheckSandbox(root);
    cleanups.push(sandbox.cleanup);
    expect(sandbox.gitMetadata).toBe(false);
    launches.splice(0);
    return sandbox;
  }

  /** Runs one hanging check under fake timers; returns when it settled, if it did. */
  async function hangFor(sandbox: Awaited<ReturnType<typeof preparedSandbox>>, ms: number) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    nextChildren.push("hang");
    let settled: Awaited<ReturnType<typeof sandbox.run>> | undefined;
    const running = sandbox.run("/usr/bin/make", ["docs-check"]).then((result) => {
      settled = result;
      return result;
    });
    await vi.advanceTimersByTimeAsync(ms);
    return { running, settled: () => settled };
  }

  it("stops a check at the declared ten-minute default, not at 30 seconds (#1932)", async () => {
    const sandbox = await preparedSandbox();
    const { running, settled } = await hangFor(sandbox, 45_000);
    // A 45 s check is still running: the old 30 s clamp would have stopped it.
    expect(settled()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000 - 45_000 - 1);
    expect(settled()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1 + 250);
    expect(await running).toMatchObject({
      status: "failed",
      reason: "timeout",
      timeoutMs: 600_000,
    });
    expect((await running).elapsedMs).toBeGreaterThanOrEqual(600_000);
  });

  it("honors a raised DOCSFAB_CHECKS_COMMAND_TIMEOUT_MS on the production seam (#1932)", async () => {
    vi.stubEnv("DOCSFAB_CHECKS_COMMAND_TIMEOUT_MS", "900000");
    const sandbox = await preparedSandbox();
    const { running, settled } = await hangFor(sandbox, 600_000 + 250);
    expect(settled()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await running).toMatchObject({
      status: "failed",
      reason: "timeout",
      timeoutMs: 900_000,
    });
  });

  it.each([
    ["the default", undefined, 8_192],
    ["a raised DOCSFAB_CHECKS_OUTPUT_RETAINED_BYTES", "32768", 16_384],
  ])(
    "keeps the head and tail of one large output chunk under %s budget (#1932)",
    async (_name, override, half) => {
      if (override) vi.stubEnv("DOCSFAB_CHECKS_OUTPUT_RETAINED_BYTES", override);
      const sandbox = await preparedSandbox();
      // One 64 KiB chunk that crosses the head boundary, then exit 0.
      const chunk = Buffer.concat([Buffer.alloc(32_768, "h"), Buffer.alloc(32_768, "t")]);
      nextChildren.push({ chunks: [chunk], code: 0 });
      const result = await sandbox.run("/usr/bin/make", ["docs-check"]);
      expect(result).toMatchObject({
        status: "passed",
        exitCode: 0,
        outputBytes: 65_536,
        outputOmittedBytes: 65_536 - 2 * half,
      });
      expect(result).not.toHaveProperty("reason");
      expect(result.output).toBe(
        `${"h".repeat(half)}\n[${65_536 - 2 * half} bytes of output omitted]\n${"t".repeat(half)}`,
      );
    },
  );

  it("replaces control bytes the run-record reader refuses, keeping tab and line breaks (#1932)", async () => {
    const sandbox = await preparedSandbox();
    nextChildren.push({
      chunks: [Buffer.from("ok\u0000\t\u001b[31mred\u007f\r\n", "utf8")],
      code: 0,
    });
    const result = await sandbox.run("/usr/bin/make", ["docs-check"]);
    expect(result.output).toBe("ok�\t�[31mred�\r\n");
  });

  it("resolves a program inside the sandbox before a check runs (#1918)", async () => {
    const sandbox = await preparedSandbox();
    nextChildren.push({ chunks: [Buffer.from("/usr/local/bin/python3")], code: 0 });
    expect(await sandbox.resolveExecutable(["/usr/bin/python3", "/usr/local/bin/python3"])).toBe(
      "/usr/local/bin/python3",
    );
    // The probe is DocsFab's node inside the same bubblewrap sandbox, never the program.
    const probe = launches.at(-1)!;
    expect(probe.executable).toBe("/usr/bin/bwrap");
    expect(probe.args.slice(probe.args.indexOf("--") + 1)).toEqual([
      GOLDEN_NODE,
      "-e",
      expect.stringContaining("accessSync"),
      "/usr/bin/python3",
      "/usr/local/bin/python3",
    ]);
    // Nothing found, or an answer that is not a candidate, resolves nothing.
    nextChildren.push({ chunks: [], code: 0 });
    expect(await sandbox.resolveExecutable(["/usr/bin/make"])).toBeUndefined();
    nextChildren.push({ chunks: [Buffer.from("/tmp/elsewhere")], code: 0 });
    expect(await sandbox.resolveExecutable(["/usr/bin/make"])).toBeUndefined();
    expect(sandbox.searchPath).toEqual(
      String(checkSandboxEnvironment(GOLDEN_NODE, "<SCRATCH>").PATH).split(":"),
    );
  });

  it("bounds the in-sandbox resolution probe by the declared check limit, not the readiness probe's 5 s (#1918)", async () => {
    const sandbox = await preparedSandbox();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    nextChildren.push("hang");
    let settled = false;
    const resolving = sandbox.resolveExecutable(["/usr/bin/make"]).then((resolved) => {
      settled = true;
      return resolved;
    });
    // A probe that is only slow on a loaded host is not read as a missing program.
    await vi.advanceTimersByTimeAsync(5_000 + 250);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await resolving).toBeUndefined();
  });

  it("reports a bubblewrap that cannot start before doing any Git work (#1918)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-git-unready-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const path of ["/usr/bin/bwrap", "/usr/bin", root]) present.add(path);
    // For a non-root user Git cannot write here, so Git work before the
    // readiness probe would surface as a Git fault instead of this one.
    await chmod(root, 0o555);
    cleanups.push(() => chmod(root, 0o755));
    bubblewrapOutput = "bwrap: No permissions to create new namespace";
    await expect(prepareCheckSandbox(root)).rejects.toMatchObject({
      name: "CheckSandboxPreparationError",
      stage: "bubblewrap-unavailable",
    });
    await expect(lstat(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  /** A Linux host shape over a real directory of `files`, with no `.git` of its own. */
  async function checkedCopy(prefix: string, files: Record<string, string>) {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    for (const path of ["/usr/bin/bwrap", "/usr/bin", root]) present.add(path);
    return root;
  }

  /** Git on this host over `root`, reading only that repository's own state. */
  function hostGit(root: string) {
    return (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
  }

  it("runs each presentation Git command hardened, unmaintained, quiet, and bounded (#1918)", async () => {
    const root = await checkedCopy("docsfab-git-pin-", { "docs/guide.md": "# Guide\n" });
    const sandbox = await prepareCheckSandbox(root);
    cleanups.push(sandbox.cleanup);
    expect(
      gitLaunches.map(({ args }) => args.find((arg) => /^(?:init|add|commit)$/u.test(arg))),
    ).toEqual(["init", "add", "commit"]);
    for (const { args, options } of gitLaunches) {
      // The shared hardened configuration first: no hooks, fsmonitor, or
      // filters, and no detached gc or maintenance racing cleanup.
      expect(args.slice(0, SAFE_GIT_CONFIG.length)).toEqual([...SAFE_GIT_CONFIG]);
      const configured = args.flatMap((arg, index) => (args[index - 1] === "-c" ? [arg] : []));
      expect(configured).toEqual(
        expect.arrayContaining([
          "core.hooksPath=/dev/null",
          "core.fsmonitor=false",
          "gc.auto=0",
          "maintenance.auto=false",
        ]),
      );
      // Then no per-file CRLF warnings, and the checked copy.
      expect(args.slice(SAFE_GIT_CONFIG.length, SAFE_GIT_CONFIG.length + 4)).toEqual([
        "-c",
        "core.safecrlf=false",
        "-C",
        root,
      ]);
      // Nothing inherited: no host HOME, Git config, or credential helper.
      expect(options.env).toEqual(credentialFreeGitEnvironment());
      expect((options.env as Record<string, string>).HOME).toBe("/dev/null");
      // Output is discarded, so no amount of it can fail the command; the
      // declared check limit bounds it.
      expect(options).toMatchObject({ stdio: "ignore", timeout: 600_000, killSignal: "SIGKILL" });
    }
  });

  it("keeps masked paths out of the presented commit and the masked view clean (#1918)", async () => {
    const root = await checkedCopy("docsfab-git-masked-", {
      "docs/guide.md": "# Guide\n",
      ".netrc": "machine example.invalid login fixture\n",
      "docs/.config/app.json": "{}\n",
      "docs/login.keychain": "keychain fixture\n",
      ".env.example": "EXAMPLE=1\n",
    });
    const sandbox = await prepareCheckSandbox(root);
    cleanups.push(sandbox.cleanup);
    expect(sandbox.gitMetadata).toBe(true);
    const masked = [".netrc", "docs/.config", "docs/login.keychain", ".env.example"];
    // The sandbox masks each of them.
    const args = launches[0]!.args;
    for (const path of masked) expect(args).toContain(join(root, path));
    const git = hostGit(root);
    // HEAD holds the checked tree without them, so none of their content is
    // reachable from Git inside the sandbox.
    expect(git("ls-files")).toBe("docs/guide.md\n");
    for (const path of [".netrc", "docs/.config/app.json", "docs/login.keychain", ".env.example"]) {
      expect(() => git("cat-file", "-e", `HEAD:${path}`), path).toThrow();
    }
    const excluded = (await readFile(join(root, ".git", "info", "exclude"), "utf8")).split("\n");
    expect(excluded.filter(Boolean).sort()).toEqual(masked.map((path) => `/${path}`).sort());
    // The masked view, as the sandbox shows it: empty files and an empty directory.
    for (const path of [".netrc", "docs/login.keychain", ".env.example"]) {
      await writeFile(join(root, path), "");
    }
    await rm(join(root, "docs", ".config"), { recursive: true, force: true });
    await mkdir(join(root, "docs", ".config"));
    expect(git("status", "--porcelain")).toBe("");
    expect(git("diff", "--exit-code", "HEAD")).toBe("");
  });

  it("keeps masked names with glob characters or a line break out of the commit and the view (#1918)", async () => {
    const masked = [
      "docs/[ab].keychain",
      "docs/a*b.keychain",
      "docs/q?.keychain-db",
      "docs/a\nb.keychain",
    ];
    const root = await checkedCopy("docsfab-git-masked-glob-", {
      "docs/guide.md": "# Guide\n",
      ...Object.fromEntries(masked.map((path) => [path, "keychain fixture\n"])),
    });
    const sandbox = await prepareCheckSandbox(root);
    cleanups.push(sandbox.cleanup);
    expect(sandbox.gitMetadata).toBe(true);
    // The sandbox masks each one, the line break included.
    const args = launches[0]!.args;
    for (const path of masked) expect(args, JSON.stringify(path)).toContain(join(root, path));
    const git = hostGit(root);
    // The commit holds the checked tree without them: each name excludes
    // exactly itself, never as a glob.
    expect(git("ls-files", "-z")).toBe("docs/guide.md\0");
    for (const path of masked) {
      expect(() => git("cat-file", "-e", `HEAD:${path}`), JSON.stringify(path)).toThrow();
    }
    // The masked view shows each as an empty file, which Git ignores.
    for (const path of masked) await writeFile(join(root, path), "");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("keeps the preparation failure when its cleanup fails too (#1918)", async () => {
    const root = await checkedCopy("docsfab-git-unready-cleanup-", {
      "docs/guide.md": "# Guide\n",
    });
    let scratch = "";
    // The readiness probe fails, and leaves a scratch entry this user cannot remove.
    bubblewrapOutput = "bwrap: No permissions to create new namespace";
    onLaunch = (env) => {
      scratch = env.HOME!;
      mkdirSync(join(scratch, "locked"));
      writeFileSync(join(scratch, "locked", "file"), "x");
      chmodSync(join(scratch, "locked"), 0o555);
    };
    cleanups.push(async () => {
      chmodSync(join(scratch, "locked"), 0o755);
      await rm(scratch, { recursive: true, force: true });
    });
    await expect(prepareCheckSandbox(root)).rejects.toMatchObject({
      name: "CheckSandboxPreparationError",
      stage: "bubblewrap-unavailable",
    });
  });

  it("presents Git metadata for a tree whose attributes convert line endings (#1918)", async () => {
    const files: Record<string, string> = { ".gitattributes": "* text eol=crlf\n" };
    for (let page = 0; page < 50; page += 1) files[`docs/page-${page}.md`] = `# Page ${page}\n`;
    const root = await checkedCopy("docsfab-git-eol-", files);
    const sandbox = await prepareCheckSandbox(root);
    cleanups.push(sandbox.cleanup);
    expect(sandbox.gitMetadata).toBe(true);
    const git = hostGit(root);
    expect(git("ls-files").split("\n").filter(Boolean)).toHaveLength(51);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("removes both the scratch directory and the Git metadata, then reports the first failure (#1918)", async () => {
    const root = await checkedCopy("docsfab-git-cleanup-", { "docs/guide.md": "# Guide\n" });
    const sandbox = await prepareCheckSandbox(root);
    const scratch = String((launches[0]!.options.env as Record<string, string>).HOME);
    // A scratch entry this user cannot remove.
    await mkdir(join(scratch, "locked"));
    await writeFile(join(scratch, "locked", "file"), "x");
    await chmod(join(scratch, "locked"), 0o555);
    cleanups.push(async () => {
      await chmod(join(scratch, "locked"), 0o755);
      await rm(scratch, { recursive: true, force: true });
    });
    await expect(sandbox.cleanup()).rejects.toMatchObject({ code: "EACCES" });
    // The Git metadata is gone all the same.
    await expect(lstat(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("presents credential-free, read-only Git metadata over the checked copy and removes it at cleanup (#1918)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-git-metadata-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
    for (const path of ["/usr/bin/bwrap", "/usr/bin", root]) present.add(path);
    const sandbox = await prepareCheckSandbox(root);
    expect(sandbox.gitMetadata).toBe(true);
    const git = hostGit(root);
    // One commit of the checked tree, by DocsFab's fixed identity.
    expect(git("ls-files")).toBe("docs/guide.md\n");
    expect(git("log", "--format=%an <%ae> %s")).toBe(
      "DocsFab <docsfab@example.invalid> DocsFab checked tree\n",
    );
    // No remote, no identity or credential config, and no hooks.
    expect(git("remote")).toBe("");
    expect(git("config", "--local", "--list")).not.toMatch(/remote\.|user\.|credential|url\./u);
    expect(await readdir(join(root, ".git"))).not.toContain("hooks");
    // The checkout, metadata included, is a read-only mount, and nothing masks it.
    const args = launches[0]!.args;
    expect(args.slice(args.indexOf(root) - 1, args.indexOf(root) + 2)).toEqual([
      "--ro-bind",
      root,
      root,
    ]);
    expect(args).not.toContain(join(root, ".git"));
    await sandbox.cleanup();
    await expect(lstat(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    // The checked copy itself is untouched.
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# Guide\n");
  });
});
