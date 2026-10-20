// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { readDedicatedChannelTags } from "./package-publication.mjs";

const REGISTRY_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;
const MAIN_CHANNEL_VERSION_PATTERN =
  /^(\d+\.\d+\.\d+(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)-main\.([a-f0-9]{7,12})$/u;

export function versionRelation(observed, expected) {
  const observedParts = REGISTRY_VERSION_PATTERN.exec(observed);
  const expectedParts = REGISTRY_VERSION_PATTERN.exec(expected);
  if (!observedParts || !expectedParts) return "different";
  for (const index of [1, 2, 3]) {
    const left = observedParts[index].replace(/^0+(?=\d)/u, "");
    const right = expectedParts[index].replace(/^0+(?=\d)/u, "");
    if (left.length < right.length || (left.length === right.length && left < right))
      return "stale";
    if (left.length > right.length || (left.length === right.length && left > right))
      return "newer";
  }
  if (observedParts[4] && !expectedParts[4]) return "stale";
  if (!observedParts[4] && expectedParts[4]) return "newer";
  return "different";
}

export function assertReleasePromotionAllowed(observed, target, fail) {
  if (observed === undefined || observed === target.version) return;
  const relation = versionRelation(target.version, observed);
  if (relation === "stale" || relation === "different") {
    fail("channel-downgrade-refused: latest points to a newer or incomparable release version");
  }
}

async function isAncestor(ancestor, descendant, env, run, fail) {
  try {
    await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], { env });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    fail("channel-ancestry-unknown: local committed graph could not prove source ancestry");
  }
}

async function currentProtectedHead(env, run, ancestryDepth, fail) {
  const branch = env.CI_DEFAULT_BRANCH;
  if (typeof branch !== "string" || !/^[A-Za-z0-9._/-]+$/u.test(branch)) {
    fail("default branch name is unavailable for ancestry admission");
  }
  try {
    await run(
      "git",
      [
        "fetch",
        "--deepen",
        String(ancestryDepth.value),
        "--no-tags",
        "origin",
        `refs/heads/${branch}`,
      ],
      { env },
    );
  } catch {
    fail(
      "channel-ancestry-unknown: bounded protected-branch history fetch failed; promotion is refused",
    );
  }
  const result = await run("git", ["rev-parse", "--verify", "FETCH_HEAD"], { env });
  const protectedHead = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(protectedHead)) {
    fail("channel-ancestry-unknown: protected default-branch head is malformed");
  }
  return protectedHead;
}

async function archiveSourceRevision(archivePath, env, run, runWithOutputBound, fail) {
  let result;
  try {
    result = await runWithOutputBound(
      run,
      "tar",
      ["-xOf", archivePath, "package/dist/build-identity.js"],
      { env },
      "channel archive identity readback",
    );
  } catch {
    fail("channel-ancestry-unknown: the current channel archive has no readable build identity");
  }
  const match = /DOCSFAB_BUILD_IDENTITY\s*=\s*Object\.freeze\((\{[\s\S]*?\})\);/u.exec(
    result.stdout,
  );
  let identity;
  try {
    identity = match ? JSON.parse(match[1]) : null;
  } catch {
    identity = null;
  }
  if (
    !identity ||
    identity.schemaVersion !== 1 ||
    identity.dirty !== false ||
    typeof identity.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(identity.commit)
  ) {
    fail(
      "channel-ancestry-unknown: the current channel archive build identity is invalid or dirty",
    );
  }
  return identity.commit;
}

async function currentWinnerRevision({
  observedVersion,
  packageJson,
  registry,
  env,
  run,
  workRoot,
  readVersionArchive,
  runWithOutputBound,
  fail,
}) {
  const observedMain =
    typeof observedVersion === "string" ? MAIN_CHANNEL_VERSION_PATTERN.exec(observedVersion) : null;
  if (!observedMain)
    fail("channel-ancestry-unknown: current main channel version is not an admitted main version");
  const archive = await readVersionArchive({
    name: packageJson.name,
    version: observedVersion,
    registry,
    env: { ...env, npm_config_cache: join(workRoot, "ancestry-cache") },
    run,
    destination: workRoot,
  });
  if (!archive) fail("channel-ancestry-unknown: current main channel archive is unavailable");
  const revision = await archiveSourceRevision(archive.path, env, run, runWithOutputBound, fail);
  const shortSha = observedMain[2];
  if (shortSha !== revision.slice(0, shortSha.length)) {
    fail(
      "channel-ancestry-unknown: current channel version does not match its archive source identity",
    );
  }
  return revision;
}

/** Admit only an eligible candidate whose current channel winner is its ancestor. */
export async function assertMainPromotionAllowed({
  observedVersion,
  target,
  packageJson,
  registry,
  env,
  run,
  workRoot,
  candidateSourceRevision,
  ancestryDepth,
  readVersionArchive,
  runWithOutputBound,
  fail,
}) {
  const protectedHead = await currentProtectedHead(env, run, ancestryDepth, fail);
  const candidateAncestorOfHead = await isAncestor(
    candidateSourceRevision,
    protectedHead,
    env,
    run,
    fail,
  );
  if (!candidateAncestorOfHead) {
    fail("channel-candidate-ineligible: candidate is not an ancestor of protected default branch");
  }
  if (observedVersion === undefined || observedVersion === target.version) return;
  const currentSourceRevision = await currentWinnerRevision({
    observedVersion,
    packageJson,
    registry,
    env: { ...env, npm_config_cache: join(workRoot, "ancestry-cache") },
    run,
    workRoot,
    readVersionArchive,
    runWithOutputBound,
    fail,
  });
  const winnerAncestorOfCandidate = await isAncestor(
    currentSourceRevision,
    candidateSourceRevision,
    env,
    run,
    fail,
  );
  if (winnerAncestorOfCandidate) return;
  const candidateAncestorOfWinner = await isAncestor(
    candidateSourceRevision,
    currentSourceRevision,
    env,
    run,
    fail,
  );
  if (candidateAncestorOfWinner) {
    fail(
      "channel-superseded: a newer eligible channel source already exists; immutable upload remains verified and promotion is refused",
    );
  }
  fail(
    "channel-ancestry-unknown: current channel source is divergent from candidate; promotion is refused",
  );
}

export async function readChannel({
  name,
  target,
  registry,
  env,
  run,
  runWithOutputBound,
  outputBoundCode,
  fail,
  context,
  timeoutMs,
  fetchImpl,
}) {
  const refuse = (reasonClass, message) => {
    const error = new Error(`Package publish failed: ${message}`);
    error.reasonClass = reasonClass;
    throw error;
  };
  const unknown = (reasonClass = "unknown") =>
    refuse(
      reasonClass,
      `channel-readback-unknown: ${context}; release owner must inspect ${name} dist-tag ${target.distTag} and exact version ${target.version} before retrying or changing tags.`,
    );
  let tags;
  try {
    tags = await readDedicatedChannelTags({ name, registry, env, fetchImpl, timeoutMs });
  } catch (error) {
    if (error?.reasonClass === "output_bound") throw error;
    if (error?.reasonClass) unknown(error.reasonClass);
    if (error?.code === outputBoundCode) {
      unknown("output_bound");
    }
    if (error?.reasonClass === "timeout") unknown("timeout");
    const diagnostic = `${error?.code ?? ""} ${error?.stderr ?? ""}`;
    if (/E401|E403|unauthorized|forbidden/iu.test(diagnostic)) unknown("authorization");
    if (/ETIMEDOUT|timed? out/iu.test(diagnostic)) unknown("timeout");
    if (/ECONN|ENOTFOUND|EAI_AGAIN/iu.test(diagnostic)) unknown("network");
    if (error instanceof SyntaxError) unknown("malformed");
    unknown();
  }
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) unknown("malformed");
  const observed = tags[target.distTag];
  if (
    typeof observed !== "string" ||
    (!REGISTRY_VERSION_PATTERN.test(observed) &&
      !(target.distTag === "main" && MAIN_CHANNEL_VERSION_PATTERN.test(observed)))
  )
    unknown("malformed");
  if (observed !== target.version) {
    refuse(
      "channel_mismatch",
      `channel-mismatch: dist-tag ${target.distTag} points to a ${versionRelation(observed, target.version)} version instead of ${target.version}; ${context}; release owner must inspect the registry before any tag change.`,
    );
  }
  return observed;
}

/** Retry only transient post-promotion visibility and transport failures. */
export async function readChannelWithRetry({ read, attempts, delayMs, wait = sleep }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { observedVersion: await read(), attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = ["channel_mismatch", "network", "timeout"].includes(error?.reasonClass);
      if (!retryable || attempt === attempts) break;
      await wait(delayMs);
    }
  }
  if (lastError?.reasonClass === "channel_mismatch") {
    const error = new Error(
      "channel-readback-unknown: promotion was not visible within the bounded readback window",
    );
    error.reasonClass = "eventual_visibility";
    throw error;
  }
  throw lastError;
}

function sleep(delayMs) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
}
