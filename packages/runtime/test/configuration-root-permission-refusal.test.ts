// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runtimeEgressRootSet } from "../src/config/egress-roots.js";
import {
  ConfigurationRootPermissionError,
  ensureDocsFabConfigurationRoot,
  loadDocsFabEnvironment,
} from "../src/config/host-paths.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { inspectDoctorReadiness } from "../src/doctor-readiness.js";
import { loadCompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import { egressText } from "../src/security/egress.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execFileAsync = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();
const PLACEHOLDER_KEY = "config-root-refusal-placeholder-not-a-credential";
const OPENAI_CREDENTIAL_ENVIRONMENT_NAME = ["OPENAI", "API", "KEY"].join("_");

/** Pinned as literals so the operator-facing text is checked apart from the source. */
const HOME_ROOT_NEXT_ACTION = "Run `chmod 700 ~/.config/docsfab`, then run the command again.";
const XDG_ROOT_NEXT_ACTION =
  'Run `chmod 700 "$XDG_CONFIG_HOME/docsfab"`, then run the command again.';

/** When set, `stat` of exactly this path fails, as when the root's mode cannot be read. */
const statProbe = vi.hoisted(() => ({ failPath: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((...args: Parameters<typeof actual.statSync>) => {
      const path = String(args[0]);
      if (statProbe.failPath !== null && path === statProbe.failPath) {
        throw Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), {
          code: "EACCES",
          path,
        });
      }
      return actual.statSync(...args);
    }) as typeof actual.statSync,
  };
});

afterEach(() => {
  statProbe.failPath = null;
  vi.unstubAllEnvs();
});

/** A HOME whose default configuration root exists with `mode`, selected for this process. */
async function homeWithDefaultRoot(mode: number): Promise<{ home: string; root: string }> {
  const home = await roots.create("docsfab-config-root-home-", { realpath: true });
  const root = join(home, ".config", "docsfab");
  await mkdir(root, { recursive: true });
  await chmod(root, mode);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", undefined);
  vi.stubEnv("DOCSFAB_CONFIG_ROOT", undefined);
  return { home, root };
}

async function refusal(): Promise<unknown> {
  return ensureDocsFabConfigurationRoot(process.env).then(
    () => {
      throw new Error("expected the configuration root to be refused");
    },
    (error: unknown) => error,
  );
}

describe("a default configuration root that is not owner-private", () => {
  it("names ~/.config/docsfab and a chmod next action instead of a placeholder", async () => {
    const { home } = await homeWithDefaultRoot(0o755);
    const envelope = toOperatorErrorEnvelope(await refusal());
    expect(envelope.message).toContain("~/.config/docsfab");
    expect(envelope.message).toContain("DOCSFAB_CONFIG_ROOT is not set");
    expect(envelope.message).not.toContain("$DOCSFAB_CONFIG_ROOT");
    expect(envelope.message).not.toContain(home);
    expect(envelope.nextAction).toBe(HOME_ROOT_NEXT_ACTION);
    const human = formatOperatorErrorEnvelope(envelope).split("\n");
    expect(human).toContain(`Next action: ${HOME_ROOT_NEXT_ACTION}`);
  });

  it("names $XDG_CONFIG_HOME/docsfab when XDG_CONFIG_HOME selects a root outside HOME", async () => {
    await homeWithDefaultRoot(0o700);
    const xdg = await roots.create("docsfab-config-root-xdg-", { realpath: true });
    await mkdir(join(xdg, "docsfab"), { mode: 0o700 });
    await chmod(join(xdg, "docsfab"), 0o775);
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    const envelope = toOperatorErrorEnvelope(await refusal());
    expect(envelope.message).toContain("$XDG_CONFIG_HOME/docsfab");
    expect(envelope.message).not.toContain("$DOCSFAB_CONFIG_ROOT");
    expect(envelope.message).not.toContain(xdg);
    expect(envelope.nextAction).toBe(XDG_ROOT_NEXT_ACTION);
  });

  it("accepts an owner-private default root", async () => {
    const { root } = await homeWithDefaultRoot(0o700);
    await expect(ensureDocsFabConfigurationRoot(process.env)).resolves.toBe(root);
  });

  it("names the root and the chmod next action when the root's mode cannot be read", async () => {
    const { home, root } = await homeWithDefaultRoot(0o700);
    // Positive control: the same owner-private root passes while stat works.
    await expect(ensureDocsFabConfigurationRoot(process.env)).resolves.toBe(root);
    statProbe.failPath = root;
    const error = await refusal();
    expect(error).toBeInstanceOf(ConfigurationRootPermissionError);
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.message).toBe(
      "The DocsFab configuration root ~/.config/docsfab could not be verified as an owner-private directory. DOCSFAB_CONFIG_ROOT is not set, so this is the default location.",
    );
    expect(envelope.message).not.toContain(home);
    expect(envelope.nextAction).toBe(HOME_ROOT_NEXT_ACTION);
    expect(formatOperatorErrorEnvelope(envelope).split("\n")).toContain(
      `Next action: ${HOME_ROOT_NEXT_ACTION}`,
    );

    const xdg = await roots.create("docsfab-config-root-xdg-stat-", { realpath: true });
    const xdgRoot = join(xdg, "docsfab");
    await mkdir(xdgRoot, { mode: 0o700 });
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    statProbe.failPath = xdgRoot;
    const xdgEnvelope = toOperatorErrorEnvelope(await refusal());
    expect(xdgEnvelope.message).toBe(
      "The DocsFab configuration root $XDG_CONFIG_HOME/docsfab could not be verified as an owner-private directory. DOCSFAB_CONFIG_ROOT is not set, so this is the default location.",
    );
    expect(xdgEnvelope.message).not.toContain(xdg);
    expect(xdgEnvelope.nextAction).toBe(XDG_ROOT_NEXT_ACTION);
  });

  it("still writes the configuration root as a placeholder in recorded text", async () => {
    const { root } = await homeWithDefaultRoot(0o700);
    const recorded = egressText(`Saved ${join(root, "secrets.env")}.`, runtimeEgressRootSet());
    expect(recorded).toEqual({
      ok: true,
      text: "Saved $DOCSFAB_CONFIG_ROOT/secrets.env.",
      replaced: ["config"],
    });
  });

  it("refuses docsfab setup with the root and remedy in human and --json output", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const home = await roots.create("docsfab-config-root-setup-", { realpath: true });
    const root = join(home, ".config", "docsfab");
    await mkdir(root, { recursive: true });
    await chmod(root, 0o755);
    const setup = async (extra: readonly string[]) => {
      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/cli.ts",
            "setup",
            "--provider",
            "openai",
            "--model",
            "gpt-6-sol",
            ...extra,
          ],
          {
            cwd: runtimeRoot,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: home,
              TMPDIR: tmpdir(),
              PI_OFFLINE: "1",
              OPENAI_API_KEY: PLACEHOLDER_KEY,
            },
          },
        );
        throw new Error("expected docsfab setup to refuse");
      } catch (error) {
        return error as { stdout?: string; stderr?: string; code?: number };
      }
    };

    const human = await setup([]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("The DocsFab configuration root ~/.config/docsfab ");
    expect(human.stderr).not.toContain("$DOCSFAB_CONFIG_ROOT");
    expect(human.stderr?.split("\n")).toContain(`Next action: ${HOME_ROOT_NEXT_ACTION}`);

    const json = await setup(["--json"]);
    expect(json.code).toBe(1);
    expect(json.stdout).toBe("");
    const envelope = JSON.parse(json.stderr ?? "") as Record<string, unknown>;
    expect(envelope.message).toEqual(
      expect.stringContaining("The DocsFab configuration root ~/.config/docsfab "),
    );
    expect(envelope.nextAction).toBe(HOME_ROOT_NEXT_ACTION);
    // The refusal comes before setup writes anything into the root.
    expect(existsSync(join(root, "secrets.env"))).toBe(false);
  });
});

describe("an explicit configuration root that is not owner-private", () => {
  it.each([0o755, 0o775, 0o777])(
    "refuses mode %s at the configuration read boundary before loading files",
    async (mode) => {
      const root = await roots.create("docsfab explicit config root ", { realpath: true });
      await chmod(root, mode);
      await writeFile(join(root, ".env"), "DOCSFAB_ROOT_PERMISSION_SENTINEL=loaded\n");
      const environment: NodeJS.ProcessEnv = { DOCSFAB_CONFIG_ROOT: root };

      let error: unknown;
      try {
        loadDocsFabEnvironment(environment);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ConfigurationRootPermissionError);
      expect(error).toMatchObject({ code: "configuration-root-not-private" });
      expect((error as Error).message).toContain(`mode ${mode.toString(8).padStart(4, "0")}`);
      expect((error as ConfigurationRootPermissionError).nextAction).toBe(
        'Run `chmod 700 "$DOCSFAB_CONFIG_ROOT"`, then run the command again.',
      );
      expect(environment.DOCSFAB_ROOT_PERMISSION_SENTINEL).toBeUndefined();
    },
  );

  it("accepts an explicit owner-private root and loads its legacy environment file", async () => {
    const root = await roots.create("docsfab explicit config root private ", {
      mode: 0o700,
      realpath: true,
    });
    await writeFile(join(root, ".env"), "DOCSFAB_ROOT_PERMISSION_SENTINEL=loaded\n");
    const environment: NodeJS.ProcessEnv = { DOCSFAB_CONFIG_ROOT: root };

    expect(() => loadDocsFabEnvironment(environment)).not.toThrow();
    expect(environment.DOCSFAB_ROOT_PERMISSION_SENTINEL).toBe("loaded");
  });

  it("does not create a missing default root while loading environment-only configuration", async () => {
    const xdg = await roots.create("docsfab missing xdg config ", { realpath: true });
    const missingRoot = join(xdg, "docsfab");
    const environment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdg };

    expect(() => loadDocsFabEnvironment(environment)).not.toThrow();
    expect(existsSync(missingRoot)).toBe(false);
  });

  it.each([0o755, 0o775, 0o777])(
    "refuses explicit setup root mode %s before writing configuration",
    { timeout: testTimeoutMs(60_000) },
    async (mode) => {
      const root = await roots.create("docsfab explicit setup root ", { realpath: true });
      await chmod(root, mode);
      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/cli.ts",
            "setup",
            "--provider",
            "openai",
            "--model",
            "gpt-6-sol",
          ],
          {
            cwd: runtimeRoot,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: root,
              DOCSFAB_CONFIG_ROOT: root,
              TMPDIR: tmpdir(),
              PI_OFFLINE: "1",
              [OPENAI_CREDENTIAL_ENVIRONMENT_NAME]: PLACEHOLDER_KEY,
            },
          },
        );
        throw new Error("expected docsfab setup to refuse");
      } catch (error) {
        const refusal = error as { stderr?: string; code?: number };
        expect(refusal.code).toBe(1);
        expect(refusal.stderr).toContain("configuration-root-not-private");
        expect(refusal.stderr).toContain(`mode ${mode.toString(8).padStart(4, "0")}`);
        expect(refusal.stderr).toContain('chmod 700 "$DOCSFAB_CONFIG_ROOT"');
        expect(existsSync(join(root, "secrets.env"))).toBe(false);
        expect(existsSync(join(root, "host.yaml"))).toBe(false);
      }
    },
  );

  it("accepts an explicit owner-private root for setup", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const home = await roots.create("docsfab explicit private setup ", { realpath: true });
    const root = join(home, "configuration root");
    await mkdir(root, { mode: 0o700 });
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "setup", "--provider", "openai", "--model", "gpt-6-sol"],
      {
        cwd: runtimeRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          DOCSFAB_CONFIG_ROOT: root,
          TMPDIR: tmpdir(),
          PI_OFFLINE: "1",
          [OPENAI_CREDENTIAL_ENVIRONMENT_NAME]: PLACEHOLDER_KEY,
        },
      },
    );

    expect(stdout).toContain("DocsFab setup complete");
    expect(existsSync(join(root, "secrets.env"))).toBe(true);
    expect(existsSync(join(root, "host.yaml"))).toBe(true);
  });

  it.each([0o755, 0o775, 0o777])(
    "reports explicit doctor root mode %s with the stable code and remedy",
    async (mode) => {
      const home = await roots.create("docsfab explicit doctor root ", { realpath: true });
      const root = join(home, "configuration root");
      await mkdir(root, { mode: 0o700 });
      await chmod(root, mode);
      const result = await inspectDoctorReadiness({
        cwd: runtimeRoot,
        environment: { HOME: home, DOCSFAB_CONFIG_ROOT: root },
        homeDirectory: home,
        commands: {
          run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
          probeCredential: async () => "missing",
        },
      });

      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "configuration-root-not-private",
          explanation: expect.stringContaining(`mode ${mode.toString(8).padStart(4, "0")}`),
          nextCommand: 'Run `chmod 700 "$DOCSFAB_CONFIG_ROOT"`, then run the command again.',
        }),
      );
    },
  );

  it.each([0o755, 0o775, 0o777])(
    "refuses composition run root mode %s before credential or provider setup",
    async (mode) => {
      const home = await roots.create("docsfab explicit run root ", { realpath: true });
      const root = join(home, "configuration root");
      await mkdir(root, { mode: 0o700 });
      await chmod(root, mode);
      vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);

      await expect(
        loadCompositionRunRuntime({ compositionId: "fixture", workflow: "fixture" } as never),
      ).rejects.toMatchObject({
        code: "configuration-root-not-private",
        message: expect.stringContaining(`mode ${mode.toString(8).padStart(4, "0")}`),
        nextAction: 'Run `chmod 700 "$DOCSFAB_CONFIG_ROOT"`, then run the command again.',
      });
    },
  );

  it("admits an explicit owner-private root for doctor and composition run", async () => {
    const home = await roots.create("docsfab explicit private entry roots ", { realpath: true });
    const root = join(home, "configuration root");
    await mkdir(root, { mode: 0o700 });
    const environment = { HOME: home, DOCSFAB_CONFIG_ROOT: root };
    const doctor = await inspectDoctorReadiness({
      cwd: runtimeRoot,
      environment,
      homeDirectory: home,
      commands: {
        run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
        probeCredential: async () => "missing",
      },
    });
    expect(doctor.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "configuration-root-not-private" }),
    );

    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    const runError = await loadCompositionRunRuntime({
      compositionId: "fixture",
      workflow: "fixture",
    } as never).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(runError).not.toMatchObject({ code: "configuration-root-not-private" });
  });
});
