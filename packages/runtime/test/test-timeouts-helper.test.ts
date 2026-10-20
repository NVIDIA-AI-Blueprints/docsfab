// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { LIMIT_DEFINITIONS, LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import {
  TEST_TIMEOUT_LIMITS,
  hookTimeoutMs,
  isCiEnvironment,
  nestedDeadlineMs,
  testTimeoutMs,
  vitestDefaultTimeouts,
} from "./helpers/test-timeouts.js";

const local = Object.freeze({});
const ci = Object.freeze({ CI: "true" });
const testRoot = dirname(fileURLToPath(import.meta.url));

function catalogMs(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (definition === undefined) throw new Error(`missing ${name}`);
  expect(definition.unit).toBe("ms");
  return definition.value;
}

type RegisteredCallback = (...args: never[]) => unknown;

async function pairingRegistration(environment: { readonly CI?: string }) {
  const setups: { callback: RegisteredCallback; timeout: number | undefined }[] = [];
  const teardowns: RegisteredCallback[] = [];
  const tests: { title: string; row: readonly unknown[]; callback: RegisteredCallback }[] = [];
  const suites: string[] = [];
  vi.resetModules();
  vi.stubEnv("CI", environment.CI);
  vi.doMock("vitest", async (importOriginal) => {
    const original = await importOriginal<typeof import("vitest")>();
    const register = Object.assign(
      (title: string, callback: RegisteredCallback) => tests.push({ title, row: [], callback }),
      {
        each:
          (rows: readonly (readonly unknown[])[]) =>
          (title: string, callback: RegisteredCallback) => {
            for (const row of rows) tests.push({ title: format(title, ...row), row, callback });
          },
      },
    );
    return {
      ...original,
      beforeAll: (callback: RegisteredCallback, timeout?: number) =>
        setups.push({ callback, timeout }),
      afterAll: (callback: RegisteredCallback) => teardowns.push(callback),
      describe: (title: string, callback: () => void) => {
        suites.push(title);
        callback();
      },
      it: register,
    };
  });
  try {
    // Only suite declarations execute; every producer and consumer callback is retained inert.
    await import("./pairing/outcome-consumers.test.js");
    return {
      setups,
      teardowns,
      tests,
      identity: {
        suites,
        setups: setups.map(({ callback }) => callback.toString()),
        teardowns: teardowns.map((callback) => callback.toString()),
        tests: tests.map(({ title, row, callback }) => ({
          title,
          row,
          callback: callback.toString(),
        })),
      },
    };
  } finally {
    vi.doUnmock("vitest");
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

describe("CI-aware runtime test budgets", () => {
  it("sources the Vitest defaults from the limits catalog and preserves the prior values", () => {
    expect(catalogMs(TEST_TIMEOUT_LIMITS.localTest)).toBe(5_000);
    expect(catalogMs(TEST_TIMEOUT_LIMITS.localHook)).toBe(10_000);
    expect(catalogMs(TEST_TIMEOUT_LIMITS.ciTest)).toBe(180_000);
    expect(catalogMs(TEST_TIMEOUT_LIMITS.ciHook)).toBe(300_000);
    expect(vitestDefaultTimeouts(local)).toEqual({ testTimeout: 5_000, hookTimeout: 10_000 });
    expect(vitestDefaultTimeouts(ci)).toEqual({ testTimeout: 180_000, hookTimeout: 300_000 });
  });

  it("keeps the prior truthy CI detection", () => {
    expect(isCiEnvironment({})).toBe(false);
    expect(isCiEnvironment({ CI: "" })).toBe(false);
    expect(isCiEnvironment({ CI: "1" })).toBe(true);
    expect(isCiEnvironment({ CI: "true" })).toBe(true);
  });

  it("returns local budgets unchanged outside CI so local runs still fail fast", () => {
    expect(testTimeoutMs(15_000, local)).toBe(15_000);
    expect(nestedDeadlineMs(10_000, 15_000, local)).toBe(10_000);
  });

  it("never lets a per-case budget drop below the shared CI default", () => {
    const ciTest = catalogMs(TEST_TIMEOUT_LIMITS.ciTest);
    expect(testTimeoutMs(10_000, ci)).toBe(ciTest);
    expect(testTimeoutMs(ciTest, ci)).toBe(ciTest);
    expect(testTimeoutMs(ciTest + 1, ci)).toBe(ciTest + 1);
  });

  it("uses the existing hook floor independently of the test floor", () => {
    const ciHook = catalogMs(TEST_TIMEOUT_LIMITS.ciHook);
    expect(hookTimeoutMs(150_000, ci)).toBe(ciHook);
    expect(hookTimeoutMs(ciHook, ci)).toBe(ciHook);
    expect(hookTimeoutMs(ciHook + 1, ci)).toBe(ciHook + 1);
    expect(hookTimeoutMs(Number.MAX_SAFE_INTEGER, ci)).toBe(Number.MAX_SAFE_INTEGER);
    expect(testTimeoutMs(150_000, ci)).toBe(180_000);
    expect(nestedDeadlineMs(150_000, 150_000, ci)).toBe(180_000);
  });

  it.each([undefined, "", "1", "true", "false", "0", " "])(
    "preserves local hook budgets and prior truthy CI detection for %s",
    (CI) => {
      const environment = { CI };
      expect(hookTimeoutMs(150_000, environment)).toBe(CI ? 300_000 : 150_000);
      expect(hookTimeoutMs(300_001, environment)).toBe(300_001);
      expect(hookTimeoutMs(1, environment)).toBe(CI ? 300_000 : 1);
    },
  );

  it("refuses invalid hook budgets before selecting either environment", () => {
    for (const invalid of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      for (const environment of [local, ci]) {
        expect(() => hookTimeoutMs(invalid, environment)).toThrow(
          `Local hook budget must be a positive integer millisecond budget, received ${invalid}.`,
        );
      }
    }
  });

  it("refuses a missing or wrong-unit generated hook floor", async () => {
    for (const definition of [undefined, { value: 300_000, unit: "seconds" }]) {
      vi.resetModules();
      vi.doMock("../src/config/limits.generated.js", () => ({
        LIMIT_DEFINITION_BY_NAME: {
          ...LIMIT_DEFINITION_BY_NAME,
          [TEST_TIMEOUT_LIMITS.ciHook]: definition,
        },
      }));
      try {
        const helper = await import("./helpers/test-timeouts.js");
        expect(helper.hookTimeoutMs(150_000, local)).toBe(150_000);
        expect(() => helper.hookTimeoutMs(150_000, ci)).toThrow(
          definition === undefined
            ? `Test timeout limit ${TEST_TIMEOUT_LIMITS.ciHook} is missing from the generated limits mirror`
            : `Test timeout limit ${TEST_TIMEOUT_LIMITS.ciHook} must use unit ms, found seconds.`,
        );
      } finally {
        vi.doUnmock("../src/config/limits.generated.js");
        vi.resetModules();
      }
    }
  });

  it("names the inherited pairing producer local hook allowance in its own catalog axis", () => {
    expect(catalogMs("test.pairingProducerLocalHookTimeoutMs")).toBe(150_000);
  });

  it(
    "registers all actual pairing callbacks unchanged across isolated local and CI contexts",
    async () => {
      const outsideCi = await pairingRegistration(local);
      const inCi = await pairingRegistration(ci);
      for (const registration of [outsideCi, inCi]) {
        expect(registration.setups).toHaveLength(1);
        expect(registration.teardowns).toHaveLength(1);
        expect(registration.tests).toHaveLength(126);
      }
      expect(inCi.identity).toEqual(outsideCi.identity);
      expect(outsideCi.setups[0]?.timeout).toBe(150_000);
    },
    testTimeoutMs(catalogMs(TEST_TIMEOUT_LIMITS.ciTest)),
  );

  it.each([undefined, "", "1", "true", "false", "0", " "])(
    "wires the actual pairing producer hook to the hook policy for CI=%s",
    async (CI) => {
      const registration = await pairingRegistration({ CI });
      expect(registration.setups).toHaveLength(1);
      expect(registration.tests).toHaveLength(126);
      expect(registration.setups[0]?.timeout).toBe(CI ? 300_000 : 150_000);
    },
    testTimeoutMs(catalogMs(TEST_TIMEOUT_LIMITS.ciTest)),
  );

  it(
    "refuses actual pairing registration when its local allowance is missing from the mirror",
    async () => {
      const name = "test.pairingProducerLocalHookTimeoutMs";
      vi.doMock("../src/config/limits.generated.js", () => ({
        LIMIT_DEFINITIONS: LIMIT_DEFINITIONS.filter((definition) => definition.name !== name),
        LIMIT_DEFINITION_BY_NAME: Object.fromEntries(
          Object.entries(LIMIT_DEFINITION_BY_NAME).filter(([key]) => key !== name),
        ),
      }));
      try {
        await expect(pairingRegistration(local)).rejects.toThrow(
          `Unknown operational limit ${name} is not declared in config/limits.yaml.`,
        );
      } finally {
        vi.doUnmock("../src/config/limits.generated.js");
        vi.resetModules();
      }
    },
    testTimeoutMs(catalogMs(TEST_TIMEOUT_LIMITS.ciTest)),
  );

  it("scales a nested deadline with its enclosing case so it still fires first in CI", () => {
    const ciTest = catalogMs(TEST_TIMEOUT_LIMITS.ciTest);
    const single = nestedDeadlineMs(10_000, 15_000, ci);
    expect(single).toBe(Math.floor((10_000 * ciTest) / 15_000));
    expect(single).toBeGreaterThan(10_000);
    expect(single).toBeLessThan(testTimeoutMs(15_000, ci));
    const sequential = nestedDeadlineMs(10_000, 25_000, ci);
    expect(2 * sequential).toBeLessThan(testTimeoutMs(25_000, ci));
    expect(nestedDeadlineMs(15_000, 15_000, ci)).toBe(testTimeoutMs(15_000, ci));
  });

  it("refuses budgets that cannot be honest millisecond bounds", () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => testTimeoutMs(invalid, local)).toThrow("Local test budget must be a positive");
      expect(() => testTimeoutMs(invalid, ci)).toThrow("Local test budget must be a positive");
    }
    expect(() => nestedDeadlineMs(15_001, 15_000, local)).toThrow(
      "Nested deadline 15001 ms exceeds its enclosing local test budget 15000 ms.",
    );
  });

  it.each([
    "cli-help.test.ts",
    "editorial-runtime-integration.test.ts",
    "governed-skills.test.ts",
    "knowledge-durable-continuation.test.ts",
    "quality-artifact-staging.test.ts",
  ])("keeps %s free of fixed per-case budgets that bypass the CI default", async (file) => {
    const source = await readFile(join(testRoot, file), "utf8");
    expect(source).not.toMatch(/\}, \d[\d_]*\);\n/u);
    expect(source).not.toMatch(/\n {4}\d[\d_]*,\n {2}\);/u);
    expect(source).not.toMatch(/(?:testTimeout|timeout|hookTimeout): \d/u);
    expect(source).toContain("./helpers/test-timeouts.js");
  });
});
