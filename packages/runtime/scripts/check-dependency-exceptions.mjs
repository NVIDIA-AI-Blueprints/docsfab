// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
import { dependencyAdvisoryPolicy as dependencyPolicy } from "./dependency-advisory-policy.mjs";

export const advisory = Object.freeze({
  id: dependencyPolicy.advisoryId,
  package: dependencyPolicy.package,
  affectedThrough: dependencyPolicy.affectedThrough,
  patched: dependencyPolicy.patched,
});

// Replace this record with null after a verified remediation. Keep this script
// enabled so its production-tree scan continues to reject reintroduction.
export const activeException =
  dependencyPolicy.status === "contained"
    ? {
        pi: dependencyPolicy.pi,
        minimatch: dependencyPolicy.minimatch,
        minimatchBraceRange: dependencyPolicy.minimatchBraceRange,
        braceExpansion: dependencyPolicy.braceExpansion,
        reviewOn: dependencyPolicy.reviewOn,
      }
    : null;

const piPath = "node_modules/@earendil-works/pi-coding-agent";
const minimatchPath = `${piPath}/node_modules/minimatch`;
const braceExpansionPath = `${piPath}/node_modules/brace-expansion`;

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return match?.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return undefined;
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function productionBraceExpansionPackages(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(
      ([path, metadata]) => path.endsWith("node_modules/brace-expansion") && metadata.dev !== true,
    )
    .map(([path, metadata]) => ({ path, version: metadata.version }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Validate both the active exception and the permanent advisory guard.
 * Set exception to null after remediation; the production-tree scan then
 * remains in CI to reject reintroduction of an affected brace-expansion.
 */
export function validateDependencyState({ packageJson, lock, today, exception = activeException }) {
  const failures = [];
  const bracePackages = productionBraceExpansionPackages(lock);
  const affected = [];

  for (const entry of bracePackages) {
    const comparison = compareVersions(entry.version, advisory.affectedThrough);
    if (comparison === undefined) {
      failures.push(
        `Cannot classify ${entry.path}@${entry.version ?? "missing"} against ${advisory.id}.`,
      );
    } else if (comparison <= 0) {
      affected.push(entry);
    }
  }

  if (!exception) {
    for (const entry of affected) {
      failures.push(`${advisory.id} was reintroduced at ${entry.path}@${entry.version}.`);
    }
    return failures;
  }

  const actual = {
    rootPi: packageJson.dependencies?.["@earendil-works/pi-coding-agent"],
    pi: lock.packages?.[piPath]?.version,
    hasShrinkwrap: lock.packages?.[piPath]?.hasShrinkwrap,
    minimatch: lock.packages?.[minimatchPath]?.version,
    minimatchBraceRange: lock.packages?.[minimatchPath]?.dependencies?.["brace-expansion"],
    braceExpansion: lock.packages?.[braceExpansionPath]?.version,
  };

  if (actual.rootPi !== exception.pi || actual.pi !== exception.pi) {
    failures.push(
      `Pi changed from the reviewed ${exception.pi} pin (package.json=${actual.rootPi ?? "missing"}, lock=${actual.pi ?? "missing"}).`,
    );
  }
  if (actual.hasShrinkwrap !== true) {
    failures.push("Pi is no longer marked as shrinkwrapped in package-lock.json.");
  }
  if (actual.minimatch !== exception.minimatch) {
    failures.push(
      `Pi's nested minimatch changed from ${exception.minimatch} to ${actual.minimatch ?? "missing"}.`,
    );
  }
  if (actual.minimatchBraceRange !== exception.minimatchBraceRange) {
    failures.push(
      `minimatch's brace-expansion range changed from ${exception.minimatchBraceRange} to ${actual.minimatchBraceRange ?? "missing"}.`,
    );
  }
  if (actual.braceExpansion !== exception.braceExpansion) {
    failures.push(
      `Pi's nested brace-expansion changed from ${exception.braceExpansion} to ${actual.braceExpansion ?? "missing"}.`,
    );
  }

  const expectedAffectedPath = affected.find(
    (entry) => entry.path === braceExpansionPath && entry.version === exception.braceExpansion,
  );
  if (!expectedAffectedPath) {
    failures.push(
      `The reviewed affected path is absent or patched; remove the ${advisory.id} exception after an online audit.`,
    );
  }
  for (const entry of affected) {
    if (entry.path !== braceExpansionPath || entry.version !== exception.braceExpansion) {
      failures.push(`Unexpected ${advisory.id} path: ${entry.path}@${entry.version}.`);
    }
  }
  if (today >= exception.reviewOn) {
    failures.push(
      `${advisory.id} containment review is due (${exception.reviewOn}); refresh registry, tree, applicability, and online audit evidence.`,
    );
  }

  return failures;
}

function main() {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const failures = validateDependencyState({ packageJson, lock, today });

  if (failures.length > 0) {
    console.error(`Dependency exception ${advisory.id} requires review:`);
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(
      "If the advisory is fixed, remove the active exception but keep the reintroduction guard. Otherwise refresh docs/reference/operations/dependency-exceptions.md.",
    );
    process.exitCode = 1;
    return;
  }

  if (activeException) {
    console.log(
      `Verified temporary ${advisory.id} exception: Pi ${activeException.pi} -> minimatch ${activeException.minimatch} -> brace-expansion ${activeException.braceExpansion} (review before ${activeException.reviewOn}).`,
    );
  } else {
    console.log(`Verified no affected production path for ${advisory.id}.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
