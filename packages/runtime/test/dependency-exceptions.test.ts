// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  activeException,
  validateDependencyState,
} from "../scripts/check-dependency-exceptions.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const PI_PATH = "node_modules/@earendil-works/pi-coding-agent";
const MINIMATCH_PATH = `${PI_PATH}/node_modules/minimatch`;
const BRACE_EXPANSION_PATH = `${PI_PATH}/node_modules/brace-expansion`;

function cloneLock(): typeof packageLock {
  return structuredClone(packageLock);
}

// A synthetic GHSA-mh99-v99m-4gvg containment (Pi 0.83.0 -> minimatch 10.2.5 ->
// brace-expansion 5.0.7), overriding only fields the real package.json and lock
// no longer carry. The real files have no active exception, so this keeps
// validateDependencyState's "contained exception" branches covered.
const historicalContainedException = {
  pi: "0.83.0",
  minimatch: "10.2.5",
  minimatchBraceRange: "^5.0.5",
  braceExpansion: "5.0.7",
  reviewOn: "2026-08-31",
};

function historicalPackageJsonFixture(): typeof packageJson {
  const json = structuredClone(packageJson);
  json.dependencies["@earendil-works/pi-coding-agent"] = historicalContainedException.pi;
  return json;
}

function historicalLockFixture(): typeof packageLock {
  const lock = cloneLock();
  lock.packages[PI_PATH].version = historicalContainedException.pi;
  // Pi 1.x no longer publishes a shrinkwrap; the historical Pi did.
  (lock.packages[PI_PATH] as { hasShrinkwrap?: boolean }).hasShrinkwrap = true;
  lock.packages[MINIMATCH_PATH].version = historicalContainedException.minimatch;
  lock.packages[MINIMATCH_PATH].dependencies["brace-expansion"] =
    historicalContainedException.minimatchBraceRange;
  // Pi 1.x installs brace-expansion at the root; the historical chain nested it under Pi.
  const hoisted = lock.packages["node_modules/brace-expansion"];
  delete lock.packages["node_modules/brace-expansion"];
  lock.packages[BRACE_EXPANSION_PATH] = {
    ...(lock.packages[BRACE_EXPANSION_PATH] ?? hoisted),
    version: historicalContainedException.braceExpansion,
  };
  return lock;
}

describe("dependency advisory guard", () => {
  it("finds no affected production path in the real, remediated tree", () => {
    expect(
      validateDependencyState({ packageJson, lock: packageLock, today: "2026-08-31" }),
    ).toEqual([]);
  });

  it("accepts only the reviewed vulnerable path while a containment exception is active", () => {
    expect(
      validateDependencyState({
        packageJson: historicalPackageJsonFixture(),
        lock: historicalLockFixture(),
        today: "2026-08-03",
        exception: historicalContainedException,
      }),
    ).toEqual([]);
  });

  it("fails closed when a containment review becomes due", () => {
    expect(
      validateDependencyState({
        packageJson: historicalPackageJsonFixture(),
        lock: historicalLockFixture(),
        today: historicalContainedException.reviewOn,
        exception: historicalContainedException,
      }),
    ).toContain(
      "GHSA-mh99-v99m-4gvg containment review is due (2026-08-31); refresh registry, tree, applicability, and online audit evidence.",
    );
  });

  it("requires removal of an obsolete exception after remediation", () => {
    const lock = historicalLockFixture();
    lock.packages[BRACE_EXPANSION_PATH].version = "5.0.8";

    expect(
      validateDependencyState({
        packageJson: historicalPackageJsonFixture(),
        lock,
        today: "2026-08-03",
        exception: historicalContainedException,
      }),
    ).toContain(
      "The reviewed affected path is absent or patched; remove the GHSA-mh99-v99m-4gvg exception after an online audit.",
    );
  });

  it("detects another affected production path while a containment exception is active", () => {
    const lock = historicalLockFixture();
    lock.packages["node_modules/example/node_modules/brace-expansion"] = {
      version: "5.0.6",
    };

    expect(
      validateDependencyState({
        packageJson: historicalPackageJsonFixture(),
        lock,
        today: "2026-08-03",
        exception: historicalContainedException,
      }),
    ).toContain(
      "Unexpected GHSA-mh99-v99m-4gvg path: node_modules/example/node_modules/brace-expansion@5.0.6.",
    );
  });

  it("keeps detecting reintroduction now that the exception is retired", () => {
    const reintroducedLock = historicalLockFixture();

    expect(
      validateDependencyState({
        packageJson,
        lock: reintroducedLock,
        today: "2026-08-03",
        exception: null,
      }),
    ).toContain(`GHSA-mh99-v99m-4gvg was reintroduced at ${BRACE_EXPANSION_PATH}@5.0.7.`);

    expect(
      validateDependencyState({
        packageJson,
        lock: packageLock,
        today: "2026-08-03",
        exception: null,
      }),
    ).toEqual([]);
  });
});
