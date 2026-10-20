// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI-aware Vitest budgets for runtime tests.
 *
 * The shared defaults live in config/limits.yaml (`test.*`) and reach this
 * module only through the generated mirror. A test that needs more than the
 * default declares its budget through {@link testTimeoutMs},
 * {@link hookTimeoutMs}, or {@link nestedDeadlineMs} instead of a bare literal.
 *
 * Outside CI the local budget is returned unchanged, so a hung case fails fast.
 * With `CI` set, a test or hook budget never drops below its shared CI default,
 * because loaded shared runners are much slower.
 */
import { LIMIT_DEFINITION_BY_NAME } from "../../src/config/limits.generated.js";

type Environment = Readonly<Record<string, string | undefined>>;

export const TEST_TIMEOUT_LIMITS = Object.freeze({
  localTest: "test.localTimeoutMs",
  ciTest: "test.ciTimeoutMs",
  localHook: "test.localHookTimeoutMs",
  ciHook: "test.ciHookTimeoutMs",
} as const);

function limitValueMs(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(
      `Test timeout limit ${name} is missing from the generated limits mirror; declare it in config/limits.yaml and run npm run generate:limits.`,
    );
  }
  if (definition.unit !== "ms") {
    throw new Error(`Test timeout limit ${name} must use unit ms, found ${definition.unit}.`);
  }
  return definition.value;
}

export function isCiEnvironment(environment: Environment = process.env): boolean {
  return Boolean(environment.CI);
}

function requirePositiveBudget(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer millisecond budget, received ${value}.`);
  }
}

/** Default `testTimeout` and `hookTimeout` for the runtime Vitest config. */
export function vitestDefaultTimeouts(environment: Environment = process.env): {
  readonly testTimeout: number;
  readonly hookTimeout: number;
} {
  const ci = isCiEnvironment(environment);
  return Object.freeze({
    testTimeout: limitValueMs(ci ? TEST_TIMEOUT_LIMITS.ciTest : TEST_TIMEOUT_LIMITS.localTest),
    hookTimeout: limitValueMs(ci ? TEST_TIMEOUT_LIMITS.ciHook : TEST_TIMEOUT_LIMITS.localHook),
  });
}

/**
 * Per-case or per-suite test budget. Returns `localMs` outside CI and
 * `max(localMs, test.ciTimeoutMs)` in CI.
 */
export function testTimeoutMs(localMs: number, environment: Environment = process.env): number {
  requirePositiveBudget("Local test budget", localMs);
  if (!isCiEnvironment(environment)) return localMs;
  return Math.max(localMs, limitValueMs(TEST_TIMEOUT_LIMITS.ciTest));
}

/** Explicit hook budget, retaining the local value and the separate CI hook floor. */
export function hookTimeoutMs(localMs: number, environment: Environment = process.env): number {
  requirePositiveBudget("Local hook budget", localMs);
  if (!isCiEnvironment(environment)) return localMs;
  return Math.max(localMs, limitValueMs(TEST_TIMEOUT_LIMITS.ciHook));
}

/**
 * A deadline nested inside one test case, such as a child process or a polling
 * wait. It keeps its local share of the enclosing case budget, so on a slow
 * runner it still fires with its own diagnostic before the case times out.
 */
export function nestedDeadlineMs(
  localMs: number,
  enclosingLocalTestMs: number,
  environment: Environment = process.env,
): number {
  requirePositiveBudget("Local nested deadline", localMs);
  requirePositiveBudget("Enclosing local test budget", enclosingLocalTestMs);
  if (localMs > enclosingLocalTestMs) {
    throw new Error(
      `Nested deadline ${localMs} ms exceeds its enclosing local test budget ${enclosingLocalTestMs} ms.`,
    );
  }
  if (!isCiEnvironment(environment)) return localMs;
  const enclosingMs = testTimeoutMs(enclosingLocalTestMs, environment);
  return Math.floor((localMs * enclosingMs) / enclosingLocalTestMs);
}
