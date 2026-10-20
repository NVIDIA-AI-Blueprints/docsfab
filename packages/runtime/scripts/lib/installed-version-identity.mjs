// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read the packaged build and release identity and return the exact installed
 * CLI version output, including its trailing newline.
 *
 * @param {string} installedRoot
 * @param {string} packageVersion
 * @param {(message: string) => never} [fail]
 * @param {{ sourceRevision: string }} [qualification]
 * @returns {Promise<string>}
 */
async function installedVersionIdentity(
  installedRoot,
  packageVersion,
  fail = (message) => {
    throw new Error(`Clean-install offline acceptance failed: ${message}`);
  },
  qualification,
) {
  function identityPattern(name) {
    const object = `${name} = Object\\.freeze\\((\\{[\\s\\S]*?\\})\\);`;
    if (qualification === undefined) return new RegExp(object, "u");
    // Comments are trivia, never evidence. Qualification accepts only one
    // generated static export, including an optional source-map comment.
    // Each comment stops at its first JavaScript terminator; backtracking
    // cannot absorb executable code between separate comment tokens.
    const trivia = String.raw`(?:\s|//[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)|/\*(?:[^*]|\*(?!/))*\*/)*`;
    return new RegExp(`^${trivia}export const ${object}${trivia}$`, "u");
  }
  const source = await readFile(join(installedRoot, "dist", "build-identity.js"), "utf8");
  const match = identityPattern("DOCSFAB_BUILD_IDENTITY").exec(source);
  if (!match) fail("installed build identity is missing or malformed");
  const releaseSource = await readFile(join(installedRoot, "dist", "release-identity.js"), "utf8");
  const releaseMatch = identityPattern("DOCSFAB_RELEASE_IDENTITY").exec(releaseSource);
  if (!releaseMatch) fail("installed release identity is missing or malformed");
  let identity;
  let releaseIdentity;
  try {
    identity = JSON.parse(match[1]);
    releaseIdentity = JSON.parse(releaseMatch[1]);
  } catch {
    fail("installed version identity is not valid JSON");
  }
  // Display-only callers retain their historical output. Qualification binds
  // every display branch, including prereleases, to a clean verified source.
  if (qualification !== undefined) {
    const expected = qualification?.sourceRevision;
    if (typeof expected !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expected)) {
      return fail("expected source revision is not full hexadecimal");
    }
    if (
      !identity ||
      Array.isArray(identity) ||
      identity.schemaVersion !== 1 ||
      !releaseIdentity ||
      Array.isArray(releaseIdentity)
    ) {
      return fail("installed version identity schema mismatch");
    }
    if (identity.commit !== expected) {
      return fail("installed build does not match expected source revision");
    }
    if (identity.dirty !== false) return fail("installed build is not clean");
    const tag = releaseIdentity.releaseTag;
    if (
      tag !== null &&
      tag !== `v${packageVersion}` &&
      !(
        typeof tag === "string" &&
        !packageVersion.includes("-") &&
        new RegExp(`^v${packageVersion.replaceAll(".", "\\.")}-rc\\.(0|[1-9]\\d*)$`, "u").test(tag)
      )
    ) {
      return fail("installed release identity does not match package version");
    }
  }
  if (packageVersion.includes("-")) {
    return `${packageVersion}${identity.dirty ? ".dirty" : ""}\n`;
  }
  const tag = releaseIdentity.releaseTag;
  const verifiedCommit =
    typeof identity.commit === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(identity.commit);
  if (
    verifiedCommit &&
    identity.dirty === false &&
    (tag === `v${packageVersion}` ||
      (typeof tag === "string" &&
        new RegExp(`^v${packageVersion.replaceAll(".", "\\.")}-rc\\.(0|[1-9]\\d*)$`, "u").test(
          tag,
        )))
  ) {
    return `${tag.slice(1)}\n`;
  }
  if (verifiedCommit) {
    return `${packageVersion}-dev+${identity.commit}${identity.dirty ? ".dirty" : ""}\n`;
  }
  return `${packageVersion}+unknown\n`;
}

/**
 * Explicit source-assurance entry point. Formatter-only source revisions do
 * not expose it and cannot silently ignore a qualification option.
 * @param {string} installedRoot
 * @param {string} packageVersion
 * @param {string} sourceRevision
 * @param {(message: string) => never} [fail]
 */
async function qualifiedInstalledVersionIdentity(
  installedRoot,
  packageVersion,
  sourceRevision,
  fail,
) {
  return installedVersionIdentity(installedRoot, packageVersion, fail, {
    sourceRevision,
  });
}

export { installedVersionIdentity, qualifiedInstalledVersionIdentity };
