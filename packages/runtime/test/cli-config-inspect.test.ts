// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as filesystem from "node:fs/promises";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatConfigInspection,
  handleConfigCommand,
  inspectEffectiveConfiguration,
  parseConfigInspectArguments,
} from "../src/cli/commands/config.js";
import { parseProfileInspectionArguments } from "../src/cli/profile-arguments.js";
import { defaultExecutionHostConfig } from "../src/config/profile-projection.js";
import { buildPolicyProfileFromEndpoint } from "../src/setup/split-layout-presets.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { temporaryRoots } from "./helpers/temp.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>();
  return {
    ...actual,
    access: vi.fn(actual.access),
    readFile: vi.fn(actual.readFile),
    open: vi.fn(actual.open),
  };
});

const roots = temporaryRoots();

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(filesystem.access).mockReset();
  vi.mocked(filesystem.readFile).mockReset();
  vi.mocked(filesystem.open).mockReset();
});

describe("config inspect", () => {
  it("marks a symlinked configuration root invalid with init's canonical-root action", async () => {
    const parent = await roots.create("docsfab-config-symlink-");
    const canonical = join(parent, "canonical");
    const alias = join(parent, "alias");
    await mkdir(canonical);
    await symlink(canonical, alias);
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: alias },
      homeDirectory: parent,
    });
    expect(report.paths.find((path) => path.id === "configuration-root")).toMatchObject({
      status: "invalid",
      nextCommand: expect.stringContaining("DOCSFAB_CONFIG_ROOT"),
    });
    expect(report.nextSteps).toContainEqual(expect.stringContaining("DOCSFAB_CONFIG_ROOT"));
    expect(report.nextSteps).not.toContain("docsfab setup");
  });
  it("reports effective paths and precedence without reading secrets or mutating state", async () => {
    const root = await realpath(await roots.create("docsfab-config-inspect-"));
    await mkdir(join(root, "profiles"), { recursive: true });
    await mkdir(join(root, ".docsfab", "runs"), { recursive: true });
    await writeFile(
      join(root, "host.yaml"),
      [
        "schemaVersion: 1",
        "kind: docsfab-host-config",
        "activePolicyProfile: profiles/policy.yaml",
        "paths:",
        "  stateDir: .docsfab/runs",
        "",
      ].join("\n"),
    );
    await writeFile(join(root, "secrets.env"), "MODEL_API_KEY=do-not-print-this-secret\n");
    const before = await readdir(root);

    const report = await inspectEffectiveConfiguration({
      environment: {
        DOCSFAB_CONFIG_ROOT: root,
        MODEL_API_KEY: "do-not-print-this-secret",
      },
      homeDirectory: "/private/test-home",
    });
    const human = formatConfigInspection(report);
    const state = report.paths.find((path) => path.id === "state");
    const policy = report.paths.find((path) => path.id === "policy-profile");

    expect(state).toMatchObject({
      path: resolve(root, ".docsfab", "runs"),
      source: "host.yaml paths.stateDir",
      precedence: 2,
      exists: true,
      readable: true,
    });
    expect(policy?.path).toBe(resolve(root, "profiles", "policy.yaml"));
    expect(report.providerCalls).toBe("not-run");
    expect(report.scmCalls).toBe("not-run");
    expect(human).toContain("Host paths and their effective sources");
    expect(human).toContain("Provider calls: not-run");
    expect(human).toContain("SCM calls: not-run");
    expect(human).toContain("source=host.yaml paths.stateDir");
    expect(human).toContain("provenance=host.yaml allowlisted path override");
    expect(human).toContain("precedence=2");
    expect(human).toContain("status=ready");
    expect(human).toContain("next=docsfab setup");
    expect(human).not.toContain("do-not-print-this-secret");
    expect(await readdir(root)).toEqual(before);
  });

  it("reports absent and malformed roots with controlled next commands", async () => {
    const root = await realpath(await roots.create("docsfab-config-inspect-"));
    const report = await inspectEffectiveConfiguration({
      environment: {
        DOCSFAB_CONFIG_ROOT: root,
        DOCSFAB_STATE_DIR: "relative-state",
      },
      homeDirectory: "/private/test-home",
    });
    const state = report.paths.find((path) => path.id === "state");
    const configuration = report.paths.find((path) => path.id === "configuration-root");

    expect(configuration).toMatchObject({ status: "ready", exists: true, readable: true });
    expect(state).toMatchObject({ status: "invalid", nextCommand: "docsfab setup" });
    expect(report.nextSteps).toContain("docsfab setup");
  });

  it.each([
    ["nvidia-inference-gpt-6-sol-pi", "azure/openai/gpt-6-sol"],
    ["nvidia-nemotron-3-super-120b-a12b-pi", "nvidia/nemotron-3-super-120b-a12b"],
  ])("reports the compiled selection for %s without inventing a YAML file", async (id, model) => {
    const root = await configuredRoot(defaultExecutionHostConfig(id));
    const host = defaultExecutionHostConfig(id);
    host.active!.writing!.settings = { baseUrl: "https://inference.example.invalid/v1" };
    await writeFile(join(root, "host.yaml"), JSON.stringify(host));
    await writeFile(join(root, "secrets.env"), "unreadable-or-malformed-secret-file-content");
    const before = await readdir(root);
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });

    expect(report.profileSelections).toEqual([
      expect.objectContaining({
        slot: "policy",
        kind: "installed-composition",
        compositionId: id,
        status: "ready",
        presetModelId: model,
        modelSource: "installed composition preset",
        policySource: "installed composition preset",
      }),
    ]);
    expect(report.paths.find((path) => path.id === "profiles")).toMatchObject({
      status: "missing",
      exists: false,
      required: false,
    });
    expect(report.paths.find((path) => path.id === "policy-profile")).toBeUndefined();
    expect(report.nextSteps).toEqual([]);
    expect(report.profileReadiness).toBe("selection-only; endpoint and credentials not checked");
    const text = formatConfigInspection(report);
    expect(text).toContain(id);
    expect(text).toContain(model);
    expect(text).toContain("required=no");
    expect(text).not.toContain("need attention");
    expect(text).not.toContain("unreadable-or-malformed-secret-file-content");
    expect(vi.mocked(filesystem.readFile).mock.calls.map(([path]) => path)).not.toContain(
      join(root, "secrets.env"),
    );
    expect(vi.mocked(filesystem.open).mock.calls.map(([path]) => path)).not.toContain(
      join(root, "secrets.env"),
    );
    expect(await readdir(root)).toEqual(before);
  });

  it("emits installed selection provenance through the shipped JSON handler", async () => {
    const id = "nvidia-nemotron-3-super-120b-a12b-pi";
    const root = await configuredRoot(defaultExecutionHostConfig(id));
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleConfigCommand(["inspect", "--json"]);
    const report = JSON.parse(log.mock.calls[0]![0]);
    expect(report.profileSelections[0]).toMatchObject({ compositionId: id, status: "ready" });
    expect(report.paths.find((path: { id: string }) => path.id === "profiles")).toMatchObject({
      status: "missing",
      exists: false,
      required: false,
    });
  });

  it("reports an unknown compiled selection as invalid instead of accepting every host", async () => {
    const root = await configuredRoot(defaultExecutionHostConfig("not-an-installed-composition"));
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(report.profileSelections[0]).toMatchObject({
      slot: "policy",
      status: "invalid",
      nextCommand: "docsfab setup",
    });
    expect(report.nextSteps).toContain("docsfab setup");
  });

  it("keeps an independently selected judge YAML profile required beside a compiled policy", async () => {
    const host = defaultExecutionHostConfig("nvidia-inference-gpt-6-sol-pi");
    host.activeJudgeProfile = "profiles/judge.yaml";
    const root = await configuredRoot(host);
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(report.profileSelections[0]).toMatchObject({ slot: "policy", status: "ready" });
    expect(report.paths.find((path) => path.id === "profiles")).toMatchObject({ required: true });
    expect(report.paths.find((path) => path.id === "judge-profile")).toMatchObject({
      status: "missing",
      exists: false,
      required: true,
    });
    expect(report.nextSteps).toContain("docsfab setup");
  });

  it("resolves an independent compiled judge without requiring YAML profiles", async () => {
    const host = defaultExecutionHostConfig("nvidia-inference-gpt-6-sol-pi");
    host.activeJudgeProfile = "nvidia-nemotron-3-super-120b-a12b-pi";
    const root = await configuredRoot(host);
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(report.profileSelections).toEqual([
      expect.objectContaining({
        slot: "policy",
        compositionId: "nvidia-inference-gpt-6-sol-pi",
        status: "ready",
      }),
      expect.objectContaining({
        slot: "judge",
        compositionId: "nvidia-nemotron-3-super-120b-a12b-pi",
        status: "ready",
      }),
    ]);
    for (const selection of report.profileSelections) {
      const [executable, subject, verb, ...args] = selection.nextCommand.split(" ");
      expect([executable, subject, verb]).toEqual(["docsfab", "profile", "inspect"]);
      expect(parseProfileInspectionArguments(args)).toMatchObject({ purpose: selection.slot });
    }
    expect(report.paths.find((path) => path.id === "judge-profile")).toBeUndefined();
    expect(report.paths.find((path) => path.id === "profiles")).toMatchObject({
      required: false,
      exists: false,
    });
    expect(report.nextSteps).toEqual([]);
  });

  it("reports a retired judge as inactive and uses only an explicitly declared executable fallback", async () => {
    const host = defaultExecutionHostConfig("nvidia-inference-gpt-6-sol-pi");
    host.active = { ...host.active, judge: { compositionId: "openai-gpt-5.6-sol-pi" } };
    const root = await configuredRoot(host);
    const inactive = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(
      inactive.profileSelections.find((selection) => selection.slot === "judge"),
    ).toMatchObject({ status: "inactive" });
    expect(inactive.nextSteps).toEqual([]);
    host.active.judge!.fallbackCompositionId = "nvidia-nemotron-3-super-120b-a12b-pi";
    await writeFile(join(root, "host.yaml"), JSON.stringify(host));
    const fallback = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(
      fallback.profileSelections.find((selection) => selection.slot === "judge"),
    ).toMatchObject({ status: "ready", compositionId: "nvidia-nemotron-3-super-120b-a12b-pi" });
  });

  it("does not inspect a shadowed legacy YAML path as the active policy", async () => {
    const host = defaultExecutionHostConfig("nvidia-inference-gpt-6-sol-pi");
    host.activePolicyProfile = "profiles/shadowed.yaml";
    const root = await configuredRoot(host);
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(report.profileSelections[0]).toMatchObject({ slot: "policy", status: "ready" });
    expect(report.paths.find((path) => path.id === "policy-profile")).toBeUndefined();
    expect(report.paths.find((path) => path.id === "profiles")).toMatchObject({ required: false });
    expect(report.nextSteps).toEqual([]);
  });

  it("validates the YAML profile slot instead of accepting a judge as a policy", async () => {
    const root = await configuredRoot({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: "profiles/profile.yaml",
    });
    await mkdir(join(root, "profiles"));
    const profile = buildPolicyProfileFromEndpoint({
      provider: "openai-compatible",
      modelId: "test-model",
      baseUrl: "https://inference.example.invalid/v1",
    });
    await writeFile(
      join(root, "profiles", "profile.yaml"),
      JSON.stringify({ ...profile, slot: "judge" }),
    );
    const invalid = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(invalid.paths.find((path) => path.id === "policy-profile")).toMatchObject({
      status: "invalid",
      exists: true,
    });
    const host = defaultExecutionHostConfig("nvidia-inference-gpt-6-sol-pi");
    host.activeJudgeProfile = "profiles/profile.yaml";
    await writeFile(join(root, "host.yaml"), JSON.stringify(host));
    const valid = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(valid.paths.find((path) => path.id === "judge-profile")).toMatchObject({
      status: "ready",
      exists: true,
    });
    expect(valid.nextSteps).toEqual([]);
  });

  it.each(["root", "ancestor"])(
    "refuses a %s symlink escaping profiles before reading YAML",
    async (kind) => {
      const selected = kind === "root" ? "profiles/policy.yaml" : "profiles/alias/policy.yaml";
      const root = await configuredRoot({
        schemaVersion: 1,
        kind: "docsfab-host-config",
        activePolicyProfile: selected,
      });
      const outside = await roots.create("docsfab-config-outside-", { realpath: true });
      const target = join(outside, "policy.yaml");
      await writeFile(target, validLegacyProfile());
      if (kind === "ancestor") await mkdir(join(root, "profiles"));
      await symlink(
        outside,
        kind === "root" ? join(root, "profiles") : join(root, "profiles", "alias"),
      );
      const path = resolve(root, selected);
      const report = await inspectEffectiveConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root },
      });
      expect(report.paths.find((entry) => entry.id === "policy-profile")).toMatchObject({
        status: "invalid",
        nextCommand: "docsfab setup",
      });
      expect(report.nextSteps).toContain("docsfab setup");
      expect(vi.mocked(filesystem.readFile).mock.calls.map(([file]) => file)).not.toContain(path);
      expect(vi.mocked(filesystem.readFile).mock.calls.map(([file]) => file)).not.toContain(target);
      expect(vi.mocked(filesystem.open).mock.calls.map(([file]) => file)).not.toContain(target);
    },
  );

  it("accepts an ancestor link whose canonical target stays inside profiles", async () => {
    const root = await configuredRoot({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: "profiles/alias/policy.yaml",
    });
    const directory = join(root, "profiles", "actual");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "policy.yaml"), validLegacyProfile());
    await symlink(directory, join(root, "profiles", "alias"));
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(report.paths.find((entry) => entry.id === "policy-profile")).toMatchObject({
      status: "ready",
      exists: true,
      readable: true,
    });
    expect(report.nextSteps).toEqual([]);
  });

  it("refuses a leaf replaced by an escaping link between probe and open without consuming bytes", async () => {
    const { root, path } = await legacyConfiguration();
    const outside = await roots.create("docsfab-config-replacement-", { realpath: true });
    const target = join(outside, "policy.yaml");
    await writeFile(target, validLegacyProfile());
    const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
    let replaced = false;
    let contentRead = false;
    const replace = async () => {
      if (replaced) return;
      replaced = true;
      await actual.rename(path, `${path}.held`);
      await actual.symlink(target, path);
    };
    vi.mocked(filesystem.readFile).mockImplementation(async (file, options) => {
      if (file === path) {
        await replace();
        contentRead = true;
      }
      return actual.readFile(file, options as never);
    });
    vi.mocked(filesystem.open).mockImplementation(async (file, flags, mode) => {
      if (file === path) await replace();
      const handle = await actual.open(file, flags, mode);
      if (file === path) {
        vi.spyOn(handle, "readFile").mockImplementation(async () => {
          contentRead = true;
          return Buffer.from(validLegacyProfile());
        });
      }
      return handle;
    });
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(replaced).toBe(true);
    expect(report.paths.find((entry) => entry.id === "policy-profile")).toMatchObject({
      status: "invalid",
      nextCommand: "docsfab setup",
    });
    expect(contentRead).toBe(false);
  });

  it.each(["ancestor-link", "regular-file"])(
    "refuses a %s substitution after open before consuming descriptor bytes",
    async (kind) => {
      const { root, path } = await legacyConfiguration("profiles/nested/policy.yaml");
      const outside = await roots.create("docsfab-config-after-open-", { realpath: true });
      await writeFile(join(outside, "policy.yaml"), validLegacyProfile());
      const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
      let replaced = false;
      let contentRead = false;
      let opened: Awaited<ReturnType<typeof filesystem.open>> | undefined;
      vi.mocked(filesystem.open).mockImplementation(async (file, flags, mode) => {
        const handle = await actual.open(file, flags, mode);
        if (file === path) {
          opened = handle;
          vi.spyOn(handle, "readFile").mockImplementation(async () => {
            contentRead = true;
            return Buffer.from(validLegacyProfile());
          });
          if (kind === "ancestor-link") {
            await actual.rename(join(root, "profiles", "nested"), join(root, "profiles", "held"));
            await actual.symlink(outside, join(root, "profiles", "nested"));
          } else {
            await actual.rename(path, `${path}.held`);
            await actual.writeFile(path, validLegacyProfile());
          }
          replaced = true;
        }
        return handle;
      });
      const report = await inspectEffectiveConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root },
      });
      expect(replaced).toBe(true);
      expect(report.paths.find((entry) => entry.id === "policy-profile")).toMatchObject({
        status: "invalid",
        nextCommand: "docsfab setup",
      });
      expect(contentRead).toBe(false);
      await expect(opened!.stat()).rejects.toMatchObject({ code: "EBADF" });
    },
  );

  it("accepts a valid legacy YAML profile and preserves a missing legacy file refusal", async () => {
    const root = await configuredRoot({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: "profiles/policy.yaml",
    });
    await mkdir(join(root, "profiles"));
    const profile = buildPolicyProfileFromEndpoint({
      provider: "openai-compatible",
      modelId: "test-model",
      baseUrl: "https://inference.example.invalid/v1",
    });
    await writeFile(join(root, "profiles", "policy.yaml"), JSON.stringify(profile));
    const valid = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(valid.paths.find((path) => path.id === "policy-profile")).toMatchObject({
      status: "ready",
      exists: true,
      required: true,
    });
    expect(valid.nextSteps).toEqual([]);
    await filesystem.unlink(join(root, "profiles", "policy.yaml"));
    const missing = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(missing.paths.find((path) => path.id === "policy-profile")).toMatchObject({
      status: "missing",
      exists: false,
      nextCommand: "docsfab setup",
    });
    expect(missing.nextSteps).toContain("docsfab setup");
  });

  it.each(["not: [valid YAML", '{"schemaVersion":1,"kind":"docsfab-model-profile"}'])(
    "reports a malformed legacy profile as invalid: %s",
    async (content) => {
      const root = await configuredRoot({
        schemaVersion: 1,
        kind: "docsfab-host-config",
        activePolicyProfile: "profiles/policy.yaml",
      });
      await mkdir(join(root, "profiles"));
      await writeFile(join(root, "profiles", "policy.yaml"), content);
      const report = await inspectEffectiveConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root },
      });
      expect(report.paths.find((path) => path.id === "policy-profile")).toMatchObject({
        status: "invalid",
        exists: true,
        readable: true,
        nextCommand: "docsfab setup",
      });
      expect(report.nextSteps).toContain("docsfab setup");
    },
  );

  it("preserves an unreadable legacy file and its diagnostic action", async () => {
    const root = await configuredRoot({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: "profiles/policy.yaml",
    });
    await mkdir(join(root, "profiles"));
    const path = join(root, "profiles", "policy.yaml");
    await writeFile(path, "not readable");
    const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
    vi.mocked(filesystem.access).mockImplementation(async (candidate, mode) => {
      if (candidate === path)
        throw Object.assign(new Error("synthetic permission refusal"), { code: "EACCES" });
      return actual.access(candidate, mode);
    });
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(report.paths.find((entry) => entry.id === "policy-profile")).toMatchObject({
      status: "unreadable",
      exists: true,
      readable: false,
      nextCommand: "docsfab doctor",
    });
    expect(report.nextSteps).toContain("docsfab doctor");
  });

  it.each([
    ["ENOENT", "missing", "docsfab setup"],
    ["ENOTDIR", "missing", "docsfab setup"],
    ["EACCES", "unreadable", "docsfab doctor"],
  ])(
    "preserves a legacy read failure after a successful path probe: %s",
    async (code, status, nextCommand) => {
      const root = await configuredRoot({
        schemaVersion: 1,
        kind: "docsfab-host-config",
        activePolicyProfile: "profiles/policy.yaml",
      });
      await mkdir(join(root, "profiles"));
      const path = join(root, "profiles", "policy.yaml");
      await writeFile(path, "profile bytes disappeared after the probe");
      const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
      vi.mocked(filesystem.open).mockImplementation(async (candidate, flags, mode) => {
        if (candidate === path) throw Object.assign(new Error("synthetic read refusal"), { code });
        return actual.open(candidate, flags, mode);
      });
      const report = await inspectEffectiveConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root },
      });
      expect(report.paths.find((entry) => entry.id === "policy-profile")).toMatchObject({
        status,
        readable: false,
        nextCommand,
      });
      expect(report.nextSteps).toContain(nextCommand);
    },
  );

  it("rejects an escaping legacy path without reading it", async () => {
    const root = await configuredRoot({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: "../outside.yaml",
    });
    const report = await inspectEffectiveConfiguration({
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });
    expect(report.paths.find((path) => path.id === "policy-profile")).toMatchObject({
      status: "invalid",
      nextCommand: "docsfab setup",
    });
    expect(vi.mocked(filesystem.readFile).mock.calls.map(([path]) => path)).not.toContain(
      resolve(root, "../outside.yaml"),
    );
  });

  it.each([
    {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activeExecutionProfile: "nvidia-inference-gpt-6-sol-pi",
      compositionId: "nvidia-nemotron-3-super-120b-a12b-pi",
    },
    {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: {
          compositionId: "nvidia-inference-gpt-6-sol-pi",
          settings: { contextWindow: "malformed" },
        },
      },
    },
  ])(
    "keeps malformed host controls invalid without declaring a ready composition",
    async (host) => {
      const root = await configuredRoot(host);
      const report = await inspectEffectiveConfiguration({
        environment: { DOCSFAB_CONFIG_ROOT: root },
      });
      expect(report.paths.find((path) => path.id === "host-config")).toMatchObject({
        status: "invalid",
        exists: true,
        nextCommand: "docsfab setup",
      });
      expect(report.profileSelections).toEqual([]);
      expect(report.nextSteps).toContain("docsfab setup");
    },
  );

  it("rejects unsupported command shapes", () => {
    expect(parseConfigInspectArguments(["inspect", "--json"])).toEqual({ json: true });
    expect(() => parseConfigInspectArguments([])).toThrow(/inspect/u);
    expect(() => parseConfigInspectArguments(["inspect", "--verbose"])).toThrow(/Unknown/u);
    expect(() => parseConfigInspectArguments(["inspect", "inspect"])).toThrow(/duplicated/u);
  });

  it("refuses an unsupported shape as a usage stop that names config help", () => {
    for (const args of [["inspect", "--verbose"], ["--json"], ["inspect", "inspect"]]) {
      let failure: unknown;
      try {
        parseConfigInspectArguments(args);
      } catch (error) {
        failure = error;
      }
      const envelope = toOperatorErrorEnvelope(failure);
      expect(envelope.code).toBe("cli-usage");
      expect(envelope.failure).toMatchObject({ class: "operator-input" });
      expect(envelope.nextAction).toBe("Run `docsfab config --help` for the accepted forms.");
    }
  });
});

async function configuredRoot(host: unknown): Promise<string> {
  const root = await roots.create("docsfab-config-selection-", { realpath: true });
  for (const relative of [
    ".docsfab/runs/reports",
    ".docsfab/receipts",
    ".docsfab/logs",
    ".docsfab/live-agent/sessions",
  ]) {
    await mkdir(join(root, relative), { recursive: true });
  }
  await writeFile(join(root, "host.yaml"), JSON.stringify(host));
  return root;
}

function validLegacyProfile(): string {
  return JSON.stringify(
    buildPolicyProfileFromEndpoint({
      provider: "openai-compatible",
      modelId: "test-model",
      baseUrl: "https://inference.example.invalid/v1",
    }),
  );
}

async function legacyConfiguration(
  selected = "profiles/policy.yaml",
): Promise<{ root: string; path: string }> {
  const root = await configuredRoot({
    schemaVersion: 1,
    kind: "docsfab-host-config",
    activePolicyProfile: selected,
  });
  const path = resolve(root, selected);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, validLegacyProfile());
  return { root, path };
}
