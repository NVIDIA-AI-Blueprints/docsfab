// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleDoctorCommand } from "../src/cli/commands/doctor.js";
import { limitDefinition } from "../src/config/limits.js";
import {
  formatDoctorReadiness,
  inspectDoctorReadiness,
  type DoctorReadinessCommandRunner,
} from "../src/doctor-readiness.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  refreshConfiguredCredentials,
  registerConfiguredCredential,
} from "../src/security/configured-credentials.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const MIN_CHARS = limitDefinition("secrets.configuredCredentialMinChars");
const MIN_DISTINCT = limitDefinition("secrets.configuredCredentialMinDistinctChars");

/** A git, glab, and npm that are all unavailable, so readiness stops early and offline. */
const unavailableCommands: DoctorReadinessCommandRunner = {
  run: async () => ({ exitCode: 1, stdout: "" }),
  probeCredential: async () => "missing",
};

/** Weak configured values, built at run time and never printed. */
function weakValues() {
  const short = plantedCredentialValue(1201, MIN_CHARS.value - 2);
  // Long enough for the length minimum, from too few distinct characters.
  const repeated = plantedCredentialValue(1202, MIN_DISTINCT.value - 2).repeat(MIN_CHARS.value);
  const strong = plantedCredentialValue(1203, 32);
  expect(new Set(repeated).size).toBeLessThan(MIN_DISTINCT.value);
  return { short, repeated, strong };
}

function shorterLine(source: string): string {
  return `Configured credential not compared: ${source} has a value shorter than ${MIN_CHARS.value} characters (${MIN_CHARS.name}). Lower ${MIN_CHARS.override}, as far as ${MIN_CHARS.min}, to compare shorter values, or configure a longer credential.`;
}

function distinctLine(source: string): string {
  return `Configured credential not compared: ${source} has a value with fewer than ${MIN_DISTINCT.value} distinct characters (${MIN_DISTINCT.name}). Lower ${MIN_DISTINCT.override}, as far as ${MIN_DISTINCT.min}, to compare values with fewer distinct characters, or configure a credential with more distinct characters.`;
}

describe("docsfab doctor names configured credentials it does not compare (#1807)", () => {
  const roots = temporaryRoots();

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    refreshConfiguredCredentials();
    process.exitCode = undefined;
  });

  async function inspect(variables: NodeJS.ProcessEnv) {
    const root = await roots.create("docsfab-doctor-credentials-");
    const configuration = join(root, "configuration");
    await mkdir(configuration);
    await chmod(configuration, 0o700);
    return inspectDoctorReadiness({
      cwd: root,
      environment: { DOCSFAB_CONFIG_ROOT: configuration, ...variables },
      homeDirectory: root,
      commands: unavailableCommands,
      loadConfiguration: () => {
        throw new Error("No model profile in this fixture.");
      },
    });
  }

  it("names a weak X_PASSWORD and the rule it fails, never its value, in human and JSON output", async () => {
    const { short, repeated, strong } = weakValues();
    const result = await inspect({
      X_PASSWORD: short,
      Y_PASSWORD: repeated,
      Z_TOKEN: strong,
    });
    expect(result.configuredCredentialsNotCompared).toEqual([
      {
        source: "environment variable X_PASSWORD",
        rule: "shorter-than-minimum",
        limit: MIN_CHARS.name,
        limitValue: MIN_CHARS.value,
        override: MIN_CHARS.override,
        lowestValue: MIN_CHARS.min,
      },
      {
        source: "environment variable Y_PASSWORD",
        rule: "too-few-distinct-characters",
        limit: MIN_DISTINCT.name,
        limitValue: MIN_DISTINCT.value,
        override: MIN_DISTINCT.override,
        lowestValue: MIN_DISTINCT.min,
      },
    ]);
    const human = formatDoctorReadiness(result);
    const json = canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue);
    const lines = human.split("\n");
    expect(lines).toContain(shorterLine("environment variable X_PASSWORD"));
    expect(lines).toContain(distinctLine("environment variable Y_PASSWORD"));
    expect(human).not.toContain("Z_TOKEN");
    expect(json).toContain("environment variable X_PASSWORD");
    for (const output of [human, json]) {
      for (const value of [short, repeated, strong]) expect(output).not.toContain(value);
    }
  });

  it("prints the line through docsfab doctor and docsfab doctor --json, never the value", async () => {
    const { short } = weakValues();
    const repository = await roots.create("docsfab-doctor-credentials-cli-");
    vi.stubEnv("X_PASSWORD", short);
    refreshConfiguredCredentials();
    const printed: string[] = [];
    const capture = (message?: unknown) => {
      printed.push(String(message ?? ""));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);

    await handleDoctorCommand(["--repo", repository]);
    const human = printed.splice(0).join("\n");
    expect(human.replaceAll(/\s+/gu, " ")).toContain(
      shorterLine("environment variable X_PASSWORD"),
    );

    await handleDoctorCommand(["--json", "--repo", repository]);
    const json = printed.splice(0).join("\n");
    expect(
      (JSON.parse(json) as { configuredCredentialsNotCompared: unknown[] })
        .configuredCredentialsNotCompared,
    ).toContainEqual(
      expect.objectContaining({
        source: "environment variable X_PASSWORD",
        rule: "shorter-than-minimum",
      }),
    );
    for (const output of [human, json]) expect(output).not.toContain(short);
  });

  it("names a credential file by its variable or systemd credential name, a weak value in a credential map too", async () => {
    const { short, repeated, strong } = weakValues();
    const root = await roots.create("docsfab-doctor-credential-files-");
    const directory = join(root, "credentials");
    await mkdir(directory);
    await writeFile(join(directory, "database-password"), short);
    const map = join(root, "credentials.json");
    await writeFile(map, JSON.stringify({ credentials: { first: strong, second: repeated } }));
    const result = await inspect({
      CREDENTIALS_DIRECTORY: directory,
      DOCSFAB_FIXTURE_PROVIDER_CREDENTIAL_FILE: map,
    });
    expect(
      result.configuredCredentialsNotCompared?.map((entry) => [entry.source, entry.rule]),
    ).toEqual([
      [
        "credential file named by DOCSFAB_FIXTURE_PROVIDER_CREDENTIAL_FILE",
        "too-few-distinct-characters",
      ],
      ["systemd credential database-password", "shorter-than-minimum"],
    ]);
    const output = [
      formatDoctorReadiness(result),
      canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue),
    ].join("\n");
    for (const value of [short, repeated, strong]) expect(output).not.toContain(value);
  });

  it("drops the line when an override compares the value, and says when the setting is already at its lowest", async () => {
    const { short } = weakValues();
    const lowered = await inspect({
      X_PASSWORD: short,
      [MIN_CHARS.override!]: String(MIN_CHARS.min),
    });
    expect(short.length).toBeGreaterThanOrEqual(MIN_CHARS.min);
    expect(lowered.configuredCredentialsNotCompared).toEqual([]);
    expect(formatDoctorReadiness(lowered)).not.toContain("Configured credential not compared");

    const shortest = plantedCredentialValue(1204, MIN_CHARS.min - 1);
    const atLowest = await inspect({
      X_PASSWORD: shortest,
      [MIN_CHARS.override!]: String(MIN_CHARS.min),
    });
    expect(formatDoctorReadiness(atLowest).split("\n")).toContain(
      `Configured credential not compared: environment variable X_PASSWORD has a value shorter than ${MIN_CHARS.min} characters (${MIN_CHARS.name}). ${MIN_CHARS.override} is already at its lowest value, so configure a longer credential.`,
    );
  });

  // Last: a registration stays for the rest of this file's process.
  it("names a weak value a loader registered, never the value", async () => {
    const weak = plantedCredentialValue(1205, MIN_CHARS.value - 3);
    expect(registerConfiguredCredential(weak, "the fixture loader credential")).toBe(
      "shorter-than-minimum",
    );
    const result = await inspect({});
    expect(result.configuredCredentialsNotCompared).toContainEqual(
      expect.objectContaining({
        source: "the fixture loader credential",
        rule: "shorter-than-minimum",
      }),
    );
    const output = [
      formatDoctorReadiness(result),
      canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue),
    ].join("\n");
    expect(output).toContain(shorterLine("the fixture loader credential"));
    expect(output).not.toContain(weak);
  });
});
