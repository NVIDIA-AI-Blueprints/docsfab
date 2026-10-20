// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleDoctorCommand } from "../src/cli/commands/doctor.js";
import { limit, limitDefinition, resolveLimits } from "../src/config/limits.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import {
  createConfiguredCredentialRegistry,
  refreshConfiguredCredentials,
} from "../src/security/configured-credentials.js";
import { temporaryRoots } from "./helpers/temp.js";

const MIN_CHARS = limitDefinition("secrets.configuredCredentialMinChars");
const FRAGMENT_CHARS = limitDefinition("secrets.configuredCredentialFragmentChars");
const MIN_DISTINCT = limitDefinition("secrets.configuredCredentialMinDistinctChars");
const BOUNDS = [MIN_CHARS, FRAGMENT_CHARS, MIN_DISTINCT] as const;

/**
 * Text assembled from distinct words, never credential-shaped, long enough for
 * two values of the largest minimum that share no piece.
 */
const WORDS = [
  "fixture",
  "orchard",
  "lamp",
  "quietly",
  "hums",
  "violet",
  "harbor",
  "beacon",
  "meadow",
  "copper",
  "lattice",
  "thistle",
  "glacier",
  "pebble",
  "saffron",
  "willow",
  "ember",
  "juniper",
  "marble",
  "tundra",
].join("-");

function overrideOf(definition: (typeof BOUNDS)[number]): string {
  if (!definition.override) throw new Error(`${definition.name} has no override`);
  return definition.override;
}

function registryWith(variables: NodeJS.ProcessEnv) {
  return createConfiguredCredentialRegistry({ environment: () => variables });
}

describe("configured-credential matching limits (#1807)", () => {
  const roots = temporaryRoots();

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    refreshConfiguredCredentials();
  });

  it("declares each matching bound host-overridable, with a range around its default", () => {
    expect(BOUNDS.map(overrideOf)).toEqual([
      "DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_MIN_CHARS",
      "DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_FRAGMENT_CHARS",
      "DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_MIN_DISTINCT_CHARS",
    ]);
    for (const definition of BOUNDS) {
      expect(definition.scope, definition.name).toBe("per-host");
      expect(definition.min, definition.name).toBeLessThan(definition.max);
      expect(definition.value, definition.name).toBeLessThan(definition.max);
    }
    // The two minimums can go lower as well as higher.
    expect(MIN_CHARS.min).toBeLessThan(MIN_CHARS.value);
    expect(MIN_DISTINCT.min).toBeLessThan(MIN_DISTINCT.value);
  });

  it("accepts each override at the ends of its range and refuses one step past either at startup", () => {
    for (const definition of BOUNDS) {
      const key = overrideOf(definition);
      for (const value of [definition.min, definition.max]) {
        expect(
          limit(definition.name, { environment: { [key]: String(value) }, hostFile: null }),
          `${key}=${value}`,
        ).toMatchObject({ value, source: "host" });
      }
      const message = `${key} must be an integer between ${definition.min} and ${definition.max}.`;
      for (const value of [String(definition.min - 1), String(definition.max + 1), "twelve"]) {
        expect(
          () => resolveLimits({ environment: { [key]: value }, hostFile: null }),
          `${key}=${value}`,
        ).toThrow(message);
      }
      // The runtime loader validates every override before a run can start.
      expect(() => loadConfig({ [key]: String(definition.max + 1) }), key).toThrow(message);
    }
  });

  it("shows each override in docsfab doctor --limits as a host value", async () => {
    const state = await roots.create("docsfab-credential-limits-state-");
    vi.stubEnv("DOCSFAB_STATE_DIR", state);
    const values = [MIN_CHARS.min + 1, FRAGMENT_CHARS.max - 1, MIN_DISTINCT.min + 1];
    BOUNDS.forEach((definition, index) => {
      vi.stubEnv(overrideOf(definition), String(values[index]));
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      lines.push(String(message ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      lines.push(String(message ?? ""));
    });
    try {
      await handleDoctorCommand(["--limits"]);
      const output = lines.join("\n");
      BOUNDS.forEach((definition, index) => {
        expect(output).toContain(`${definition.name} | ${values[index]} | chars | host |`);
      });
    } finally {
      process.exitCode = undefined;
    }
  });

  it("compares a value of the length a lowered or raised minimum sets, and not one character shorter", () => {
    const key = overrideOf(MIN_CHARS);
    for (const length of [MIN_CHARS.min, MIN_CHARS.max]) {
      const atLimit = WORDS.slice(0, length);
      const belowLimit = WORDS.slice(length, length + length - 1);
      expect(new Set(atLimit).size).toBeGreaterThanOrEqual(MIN_DISTINCT.value);
      expect(new Set(belowLimit).size).toBeGreaterThanOrEqual(MIN_DISTINCT.value);
      const registry = registryWith({
        [key]: String(length),
        DOCSFAB_FIXTURE_PASSWORD: atLimit,
        DOCSFAB_SHORT_PASSWORD: belowLimit,
      });
      expect(registry.find(`a ${atLimit} b`), `${length}`).toMatchObject({
        source: "environment variable DOCSFAB_FIXTURE_PASSWORD",
        form: "value",
      });
      expect(registry.find(`a ${belowLimit} b`), `${length}`).toBeNull();
      expect(registry.inventory()).toEqual([
        { source: "environment variable DOCSFAB_FIXTURE_PASSWORD", status: "screened" },
        { source: "environment variable DOCSFAB_SHORT_PASSWORD", status: "shorter-than-minimum" },
      ]);
    }
    // Without the override, the default minimum leaves the lowest-limit value out.
    const short = WORDS.slice(0, MIN_CHARS.min);
    expect(registryWith({ DOCSFAB_FIXTURE_PASSWORD: short }).find(`a ${short} b`)).toBeNull();
  });

  it("compares a value with as few distinct characters as a lowered minimum allows, and not one fewer", () => {
    const key = overrideOf(MIN_DISTINCT);
    const allowed = MIN_DISTINCT.min + 2;
    // Repeated short words, long enough for the default length minimum.
    const repeated = (distinct: number) =>
      WORDS.replaceAll("-", "").slice(0, distinct).repeat(MIN_CHARS.value);
    const atLimit = repeated(allowed);
    const belowLimit = repeated(allowed - 1);
    expect(new Set(atLimit).size).toBe(allowed);
    expect(new Set(belowLimit).size).toBe(allowed - 1);
    const registry = registryWith({
      [key]: String(allowed),
      DOCSFAB_FIXTURE_PASSWORD: atLimit,
      DOCSFAB_REPEATED_PASSWORD: belowLimit,
    });
    expect(registry.find(`a ${atLimit} b`)).toMatchObject({
      source: "environment variable DOCSFAB_FIXTURE_PASSWORD",
      form: "value",
    });
    expect(registry.find(`a ${belowLimit} b`)).toBeNull();
    expect(registry.inventory()).toContainEqual({
      source: "environment variable DOCSFAB_REPEATED_PASSWORD",
      status: "too-few-distinct-characters",
    });
    // The default minimum leaves the same value uncompared.
    expect(registryWith({ DOCSFAB_FIXTURE_PASSWORD: atLimit }).find(`a ${atLimit} b`)).toBeNull();
    // The lowest setting turns the rule off.
    const single = "z".repeat(MIN_CHARS.value);
    const off = registryWith({ [key]: String(MIN_DISTINCT.min), DOCSFAB_FIXTURE_PASSWORD: single });
    expect(off.find(`a ${single} b`)).toMatchObject({ form: "value" });
  });

  it("matches a piece of the length a raised piece setting sets, and not one character shorter", () => {
    const key = overrideOf(FRAGMENT_CHARS);
    const length = FRAGMENT_CHARS.value + 4;
    const registry = registryWith({ [key]: String(length), DOCSFAB_FIXTURE_TOKEN: WORDS });
    const piece = WORDS.slice(3, 3 + length);
    expect(registry.find(`echo ${piece}...`)).toMatchObject({
      source: "environment variable DOCSFAB_FIXTURE_TOKEN",
      form: "fragment",
    });
    expect(registry.find(`echo ${piece.slice(0, -1)}...`)).toBeNull();
    // The default piece length still finds the shorter piece.
    expect(
      registryWith({ DOCSFAB_FIXTURE_TOKEN: WORDS }).find(`echo ${piece.slice(0, -1)}...`),
    ).toMatchObject({ form: "fragment" });
  });

  it("applies the override limit() resolves, from the host limits file and from the environment", async () => {
    const root = await roots.create("docsfab-credential-limits-file-");
    const hostFile = join(root, "service.env");
    const fromFile = MIN_CHARS.min + 1;
    const fromEnvironment = MIN_CHARS.min + 2;
    await writeFile(hostFile, `${MIN_CHARS.name}=${fromFile}\n`);
    for (const [environment, expected] of [
      [{ DOCSFAB_SERVICE_ENV_FILE: hostFile }, fromFile],
      [
        { DOCSFAB_SERVICE_ENV_FILE: hostFile, [overrideOf(MIN_CHARS)]: String(fromEnvironment) },
        fromEnvironment,
      ],
    ] as const) {
      expect(limit(MIN_CHARS.name, { environment })).toMatchObject({
        value: expected,
        source: "host",
      });
      const atLimit = WORDS.slice(0, expected);
      const registry = registryWith({
        ...environment,
        DOCSFAB_FIXTURE_PASSWORD: atLimit,
        DOCSFAB_SHORT_PASSWORD: WORDS.slice(0, expected - 1),
      });
      expect(registry.find(`a ${atLimit} b`), `${expected}`).toMatchObject({ form: "value" });
      expect(registry.inventory()).toContainEqual({
        source: "environment variable DOCSFAB_SHORT_PASSWORD",
        status: "shorter-than-minimum",
      });
    }
  });

  it("follows a changed override setting at the next check, without a refresh", () => {
    const key = overrideOf(MIN_CHARS);
    const short = WORDS.slice(0, MIN_CHARS.min);
    const variables: NodeJS.ProcessEnv = { DOCSFAB_FIXTURE_PASSWORD: short };
    const registry = registryWith(variables);
    expect(registry.find(`a ${short} b`)).toBeNull();
    variables[key] = String(MIN_CHARS.min);
    expect(registry.find(`a ${short} b`)).toMatchObject({ form: "value" });
    delete variables[key];
    expect(registry.find(`a ${short} b`)).toBeNull();
  });

  it("keeps the catalog value and warns once, by setting name, when an override skipped startup validation", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const key = overrideOf(MIN_CHARS);
    const atDefault = WORDS.slice(0, MIN_CHARS.value);
    const belowDefault = WORDS.slice(0, MIN_CHARS.value - 1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const registry = registryWith({
        [key]: String(MIN_CHARS.min - 1),
        DOCSFAB_FIXTURE_PASSWORD: atDefault,
        DOCSFAB_SHORT_PASSWORD: belowDefault,
      });
      // A screen never stops on the setting; it compares by the catalog value.
      expect(registry.find(`a ${atDefault} b`)).toMatchObject({ form: "value" });
      expect(registry.find(`a ${belowDefault} b`)).toBeNull();
    }
    expect(writes).toEqual([
      `WARNING configured-credential-limit-invalid: ${key} must be an integer between ${MIN_CHARS.min} and ${MIN_CHARS.max}. The configured-credential screens use ${MIN_CHARS.name} = ${MIN_CHARS.value} until it is corrected; docsfab doctor --limits refuses it by name.\n`,
    ]);
  });
});
