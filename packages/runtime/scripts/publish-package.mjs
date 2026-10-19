// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Publish the retained, verified `docsfab.tgz` to the project npm registry.
 *
 * Two channels, selected from the GitLab pipeline variables:
 *
 * - Release tag `vX.Y.Z`: the tag must equal `v${package.json version}`.
 *   The verified tarball is published unchanged under dist-tag `latest`.
 *   A release-cut tag `vX.Y.Z-rc.N` does not publish.
 * - Default-branch push: the final `${version}-main.${CI_COMMIT_SHORT_SHA}`
 *   version is selected before packing. The retained tarball is uploaded byte
 *   for byte, then the mutable `main` channel is promoted separately.
 *
 * The registry rejects republishing an existing name@version. Existing and
 * newly published versions succeed only when a readback confirms the intended
 * dist-tag. A mismatch or unreadable tag needs release-owner reconciliation;
 * this script never retags an existing version. Dry-run records no publication.
 *
 * Usage: node scripts/publish-package.mjs <upload|promote> <artifact-dir-leaf> [--dry-run]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  initializePublicationReceipt,
  runImmutableUploadPhase,
} from "./lib/package-upload-phase.mjs";
import { runChannelPromotionPhase } from "./lib/package-channel-promotion-phase.mjs";
import { verifyReleaseArtifact } from "./verify-release-artifact.mjs";

const defaultRun = promisify(execFile);
const PUBLISH_OUTPUT_LIMIT_NAME = "publishPackage.commandOutputBytes";
const publishOutputLimit = loadPublishOutputLimit();
const publishAncestryDepth = loadPublishLimit(
  "publishPackage.ancestryFetchDepth",
  "commits",
  "publish-package-ancestry-fetch-depth-bound",
);
const publishArchiveLimit = loadPublishLimit(
  "publishPackage.registryArchiveBytes",
  "bytes",
  "publish-package-registry-archive-bound",
);
const promotionReadAttempts = loadPublishLimit(
  "publishPackage.channelReadbackAttempts",
  "attempts",
  "publish-package-channel-readback-attempt-bound",
);
const promotionReadDelay = loadPublishLimit(
  "publishPackage.channelReadbackDelayMs",
  "milliseconds",
  "publish-package-channel-readback-delay-bound",
);
const promotionReadTimeout = loadPublishLimit(
  "publishPackage.channelReadbackTimeoutMs",
  "milliseconds",
  "publish-package-channel-readback-timeout-bound",
);
const versionReadAttempts = loadPublishLimit(
  "publishPackage.versionReadbackAttempts",
  "attempts",
  "publish-package-version-readback-attempt-bound",
);
const versionReadDelay = loadPublishLimit(
  "publishPackage.versionReadbackDelayMs",
  "milliseconds",
  "publish-package-version-readback-delay-bound",
);
const versionReadTimeout = loadPublishLimit(
  "publishPackage.versionReadbackTimeoutMs",
  "milliseconds",
  "publish-package-version-readback-timeout-bound",
);
const VERSION_TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/u;
const RELEASE_CUT_PATTERN = /^v\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/u;

function fail(message) {
  throw new Error(`Package publish failed: ${message}`);
}

const RECEIPT_FAILURE_CLASSES = new Set([
  "absent",
  "authorization",
  "channel_mismatch",
  "concurrent_writer",
  "cutover_unconfirmed",
  "download",
  "eventual_visibility",
  "malformed",
  "network",
  "output_bound",
  "size_bound",
  "superseded",
  "timeout",
  "unknown",
]);

function receiptFailureClass(error, fallback = "unknown") {
  if (RECEIPT_FAILURE_CLASSES.has(error?.reasonClass)) return error.reasonClass;
  const message = error instanceof Error ? error.message : String(error);
  if (/channel-superseded/u.test(message)) return "superseded";
  if (/promotion-cutover-unconfirmed/u.test(message)) return "cutover_unconfirmed";
  if (/channel-concurrent-update/u.test(message)) return "concurrent_writer";
  if (/publish-package-command-output-bytes-bound/u.test(message)) return "output_bound";
  if (/401|403|unauthorized|forbidden/iu.test(message)) return "authorization";
  if (/timeout|timed out|ETIMEDOUT/iu.test(message)) return "timeout";
  return fallback;
}

function loadPublishOutputLimit() {
  return loadPublishLimit(
    PUBLISH_OUTPUT_LIMIT_NAME,
    "bytes",
    "publish-package-command-output-bytes-bound",
  );
}

function loadPublishLimit(name, unit, refusal) {
  let catalog;
  try {
    catalog = JSON.parse(
      readFileSync(new URL("../../../config/limits.catalog.json", import.meta.url), "utf8"),
    );
  } catch {
    fail(`${name} mirror is unavailable; regenerate the limits mirrors.`);
  }
  const bound = catalog?.limits?.[name];
  if (
    catalog?.kind !== "docsfab-limits-catalog" ||
    !Number.isSafeInteger(bound?.value) ||
    bound.value <= 0 ||
    bound.unit !== unit ||
    bound.override !== null ||
    bound.refusal !== refusal
  ) {
    fail(`${name} mirror is invalid; regenerate the limits mirrors.`);
  }
  return bound;
}

class PublishOutputBoundError extends Error {
  constructor(stage) {
    super(
      `${publishOutputLimit.refusal}: ${stage} exceeded ${PUBLISH_OUTPUT_LIMIT_NAME} = ${publishOutputLimit.value} bytes per output stream; exact emitted bytes are unavailable. ${publishOutputLimit.remediation} The release owner must inspect the job and registry before retrying.`,
    );
    this.code = publishOutputLimit.refusal;
  }
}

class PublishReadbackTimeoutError extends Error {
  constructor(stage, timeoutMs) {
    super(
      `${stage} exceeded its configured ${timeoutMs} ms deadline; registry state remains unknown.`,
    );
    this.reasonClass = "timeout";
  }
}

export async function runWithOutputBound(run, command, args, options, stage) {
  const { timeout } = options;
  let timer;
  let deadlineExpired = false;
  try {
    if (!timeout)
      return await run(command, args, { ...options, maxBuffer: publishOutputLimit.value });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        deadlineExpired = true;
        reject(new PublishReadbackTimeoutError(stage, timeout));
      }, timeout);
    });
    return await Promise.race([
      run(command, args, {
        ...options,
        maxBuffer: publishOutputLimit.value,
        killSignal: "SIGKILL",
      }),
      deadline,
    ]);
  } catch (error) {
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new PublishOutputBoundError(stage);
    }
    if (deadlineExpired) throw new PublishReadbackTimeoutError(stage, timeout);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parseArguments(argv) {
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  const flags = argv.filter((argument) => argument.startsWith("--"));
  const phase = positional[0];
  const hasPhase = phase === "upload" || phase === "promote";
  const leaf = positional[1];
  if (!hasPhase || positional.length !== 2 || flags.some((flag) => flag !== "--dry-run")) {
    fail("usage: publish-package.mjs <upload|promote> <artifact-dir-leaf> [--dry-run]");
  }
  if (isAbsolute(leaf) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(leaf)) {
    fail("artifact directory must be one safe repository-relative leaf");
  }
  return { phase, leaf, dryRun: flags.includes("--dry-run") };
}

/**
 * @param {{ version: string }} packageJson
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ channel: "release" | "main"; version: string; distTag: string }}
 */
export function resolvePublishChannel(packageJson, env) {
  const tag = env.CI_COMMIT_TAG;
  if (tag) {
    if (RELEASE_CUT_PATTERN.test(tag)) {
      fail(`tag ${tag} is a release cut and does not publish`);
    }
    const match = VERSION_TAG_PATTERN.exec(tag);
    if (!match) {
      fail(`tag ${JSON.stringify(tag)} is not a vX.Y.Z version tag`);
    }
    if (match[1] !== packageJson.version) {
      fail(`tag ${tag} does not match package.json version ${packageJson.version}`);
    }
    return { channel: "release", version: packageJson.version, distTag: "latest" };
  }
  const branch = env.CI_COMMIT_BRANCH;
  const defaultBranch = env.CI_DEFAULT_BRANCH;
  if (!branch || !defaultBranch || branch !== defaultBranch) {
    fail("publish runs only on a version tag or a default-branch push");
  }
  const shortSha = env.CI_COMMIT_SHORT_SHA;
  if (!shortSha || !/^[a-f0-9]{7,12}$/u.test(shortSha)) {
    fail("CI_COMMIT_SHORT_SHA must be a short hexadecimal revision");
  }
  if (/-/u.test(packageJson.version)) {
    fail("package.json version must not already carry a prerelease suffix");
  }
  return {
    channel: "main",
    version: `${packageJson.version}-main.${shortSha}`,
    distTag: "main",
  };
}

function parseHttpsUrl(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${name} must be one https registry URL`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      fail(`${name} must be one https registry URL`);
    }
    return url;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Package publish failed:")) {
      throw error;
    }
    fail(`${name} must be one https registry URL`);
  }
}

/**
 * @param {{ publishConfig?: { registry?: unknown } }} packageJson
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolvePublishRegistry(packageJson, env) {
  const defaultRegistry = parseHttpsUrl(
    packageJson.publishConfig && packageJson.publishConfig.registry,
    "package.json publishConfig.registry",
  ).href;
  const ciApiV4Url = typeof env.CI_API_V4_URL === "string" ? env.CI_API_V4_URL.trim() : "";
  const ciProjectId = typeof env.CI_PROJECT_ID === "string" ? env.CI_PROJECT_ID.trim() : "";
  if (!ciApiV4Url && !ciProjectId) {
    return defaultRegistry;
  }
  if (!ciApiV4Url || !ciProjectId) {
    fail("CI_API_V4_URL and CI_PROJECT_ID must both be set to override the package registry");
  }
  if (!/^\d+$/u.test(ciProjectId)) {
    fail("CI_PROJECT_ID must be a numeric GitLab project id");
  }
  const apiUrl = parseHttpsUrl(ciApiV4Url, "CI_API_V4_URL");
  apiUrl.search = "";
  apiUrl.hash = "";
  const baseApiUrl = apiUrl.href.replace(/\/+$/u, "");
  return parseHttpsUrl(
    `${baseApiUrl}/projects/${ciProjectId}/packages/npm/`,
    "resolved CI package registry",
  ).href;
}

export async function readArtifact(artifactRoot, packageJson, env, run = defaultRun) {
  const metadata = JSON.parse(await readFile(join(artifactRoot, "metadata.json"), "utf8"));
  const tarballPath = join(artifactRoot, "docsfab.tgz");
  const tarballInfo = await stat(tarballPath);
  if (!tarballInfo.isFile() || tarballInfo.size > publishArchiveLimit.value) {
    fail(`retained tarball exceeds ${publishArchiveLimit.refusal}; publication is refused`);
  }
  const verified = await verifyReleaseArtifact({
    projectRoot: resolve(artifactRoot, ".."),
    artifactRoot,
    commitTag: env.CI_COMMIT_TAG || `v${metadata.version}`,
    commitSha: env.CI_COMMIT_SHA,
  });
  const tarball = await readFile(tarballPath);
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (metadata.artifact !== "docsfab.tgz" || metadata.integrity !== integrity) {
    fail("retained tarball bytes do not match verified integrity metadata");
  }
  const target = resolvePublishChannel(packageJson, env);
  if (
    verified.name !== packageJson.name ||
    verified.version !== target.version ||
    verified.sourceVersion !== packageJson.version ||
    verified.sourceClean !== true
  ) {
    fail("metadata name or version does not match package.json");
  }
  if (!env.CI_COMMIT_SHA || verified.sourceRevision !== env.CI_COMMIT_SHA) {
    fail("artifact source revision does not match this pipeline");
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size !== tarball.byteLength) {
    fail("retained tarball size does not match verified metadata");
  }
  if (target.channel === "main") {
    const shortSha = /-main\.([a-f0-9]{7,12})$/u.exec(target.version)?.[1];
    if (
      !shortSha ||
      shortSha !== metadata.sourceRevision.slice(0, shortSha.length) ||
      shortSha !== env.CI_COMMIT_SHA.slice(0, shortSha.length)
    ) {
      fail("main package version does not bind to its full source revision");
    }
  }
  let buildIdentity;
  try {
    const result = await runWithOutputBound(
      run,
      "tar",
      ["-xOf", tarballPath, "package/dist/build-identity.js"],
      {},
      "candidate build identity readback",
    );
    const identityMatch = /DOCSFAB_BUILD_IDENTITY\s*=\s*Object\.freeze\((\{[\s\S]*?\})\);/u.exec(
      result.stdout,
    );
    buildIdentity = identityMatch ? JSON.parse(identityMatch[1]) : null;
  } catch {
    fail("accepted package has no readable build identity");
  }
  if (
    buildIdentity?.commit !== verified.sourceRevision ||
    buildIdentity?.dirty !== false ||
    buildIdentity?.schemaVersion !== 1
  ) {
    fail("accepted package build identity does not match clean source provenance");
  }
  return tarballPath;
}

async function preparePublicationRequest({ argv, env, projectRoot, requestedPhase }) {
  const parsed = parseArguments(argv);
  const phase = requestedPhase ?? parsed.phase;
  if (phase !== "upload" && phase !== "promote") {
    fail("an explicit upload or promote phase is required");
  }
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const registry = resolvePublishRegistry(packageJson, env);
  const token = env.DOCSFAB_NPM_PUBLISH_TOKEN || env.CI_JOB_TOKEN;
  if (!token) fail("DOCSFAB_NPM_PUBLISH_TOKEN or CI_JOB_TOKEN is required");
  const target = resolvePublishChannel(packageJson, env);
  const artifactRoot = resolve(projectRoot, parsed.leaf);
  const tarballPath = await readArtifact(artifactRoot, packageJson, env);
  return {
    phase,
    dryRun: parsed.dryRun,
    packageJson,
    registry,
    token,
    target,
    artifactRoot,
    tarballPath,
    outcome: { ...target, name: packageJson.name, published: false },
  };
}

async function createNpmEnvironment({ workRoot, registry, token, env }) {
  const registryHostPath = registry.replace(/^https:/u, "");
  const userconfig = join(workRoot, ".npmrc");
  await writeFile(userconfig, `${registryHostPath}:_authToken=${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    ...env,
    npm_config_userconfig: userconfig,
    npm_config_cache: join(workRoot, "npm-cache"),
  };
}

async function prepareAcceptedCandidate({
  artifactRoot,
  tarballPath,
  phase,
  packageJson,
  target,
  fail,
}) {
  const metadata = JSON.parse(await readFile(join(artifactRoot, "metadata.json"), "utf8"));
  const expectedIntegrity = metadata.integrity;
  const candidateInfo = await stat(tarballPath);
  if (!candidateInfo.isFile() || candidateInfo.size > publishArchiveLimit.value) {
    fail(`retained tarball exceeds ${publishArchiveLimit.refusal}; publication is refused`);
  }
  const candidateBytes = await readFile(tarballPath);
  const receipt = await initializePublicationReceipt({
    phase,
    artifactRoot,
    packageJson,
    target,
    metadata,
    candidateBytes,
    expectedIntegrity,
    fail,
  });
  return { metadata, expectedIntegrity, candidateBytes, receipt };
}

function finishPublicationPhase({ phase, immutable, outcome, dependencies }) {
  if (immutable.returnValue) return immutable.returnValue;
  if (phase === "upload") {
    return {
      ...outcome,
      published: immutable.published,
      channelState: "uploaded",
      observedVersion: null,
    };
  }
  return runChannelPromotionPhase({ ...dependencies, receipt: immutable.receipt });
}

/**
 * @param {{
 *   argv: string[];
 *   env: NodeJS.ProcessEnv;
 *   projectRoot: string;
 *   run?: typeof defaultRun;
 *   log?: (line: string) => void;
 * }} options
 * @returns {Promise<{ published: boolean; name: string; version: string; distTag: string; channel: string; channelState: "verified" | "dry-run"; observedVersion: string | null }>}
 */
export async function publishPackage({
  argv,
  env,
  projectRoot,
  run = defaultRun,
  log = console.log,
  phase: requestedPhase,
  fetchImpl = globalThis.fetch,
  wait = (duration) => new Promise((resolveWait) => setTimeout(resolveWait, duration)),
}) {
  const {
    phase,
    dryRun,
    packageJson,
    registry,
    token,
    target,
    artifactRoot,
    tarballPath,
    outcome,
  } = await preparePublicationRequest({ argv, env, projectRoot, requestedPhase });

  const workRoot = await mkdtemp(join(tmpdir(), "docsfab-publish-"));
  try {
    const npmEnvironment = await createNpmEnvironment({ workRoot, registry, token, env });
    const { metadata, expectedIntegrity, candidateBytes, receipt } = await prepareAcceptedCandidate(
      {
        artifactRoot,
        tarballPath,
        phase,
        packageJson,
        target,
        fail,
      },
    );
    const immutable = await runImmutableUploadPhase({
      phase,
      dryRun,
      receipt,
      artifactRoot,
      packageJson,
      target,
      metadata,
      expectedIntegrity,
      candidateBytes,
      tarballPath,
      projectRoot,
      registry,
      run,
      runWithOutputBound,
      npmEnvironment,
      workRoot,
      fetchImpl,
      reasonClass: receiptFailureClass,
      versionReadAttempts,
      versionReadDelay,
      versionReadTimeout,
      wait,
      fail,
      log,
      outcome,
    });
    return await finishPublicationPhase({
      phase,
      immutable,
      outcome,
      dependencies: {
        dryRun,
        artifactRoot,
        packageJson,
        target,
        metadata,
        registry,
        env,
        npmEnvironment,
        run,
        workRoot,
        fetchImpl,
        ancestryDepth: publishAncestryDepth,
        runWithOutputBound,
        outputBoundCode: publishOutputLimit.refusal,
        promotionReadAttempts,
        promotionReadDelay,
        promotionReadTimeout,
        wait,
        published: immutable.published,
        outcome,
        log,
        fail,
        receiptFailureClass,
      },
    });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  publishPackage({
    argv: process.argv.slice(2),
    env: process.env,
    projectRoot: resolve(fileURLToPath(new URL("..", import.meta.url))),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
