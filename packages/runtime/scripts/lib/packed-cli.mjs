// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared packed-CLI primitives for `verify-packed-cli.mjs` and
 * `clean-install-acceptance.mjs`, which both prove the installed DocsFab
 * package rather than the source tree. The caller sets the offline policy
 * through the `env` it passes.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { EXECUTABLE_ROUTE_BASE_URLS } from "../../src/config/executable-route-urls.js";
import { verifyReleaseArtifact } from "../verify-release-artifact.mjs";

const execute = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const SOURCE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MAIN_SUFFIX_PATTERN = /^[a-f0-9]{7,12}$/u;

function isPackedVersionBoundToSource(version, sourceVersion) {
  if (
    typeof version !== "string" ||
    typeof sourceVersion !== "string" ||
    !SOURCE_VERSION_PATTERN.test(sourceVersion)
  )
    return false;
  if (version === sourceVersion) return true;
  const prefix = `${sourceVersion}-main.`;
  return version.startsWith(prefix) && MAIN_SUFFIX_PATTERN.test(version.slice(prefix.length));
}

/**
 * The shipped `.env.example` chooses no model, so a configuration built from
 * it names one explicitly, as an operator's copy must. The proofs run offline:
 * the route is public and no request reaches it.
 */
export const PACKED_PROOF_MODEL_SELECTION = Object.freeze([
  "MODEL_PROVIDER=openai-api",
  `MODEL_BASE_URL=${EXECUTABLE_ROUTE_BASE_URLS["openai-api"]}`,
  "MODEL_ID=gpt-6-sol",
]);

/** Append the explicit model selection to a configuration built from `.env.example`. */
export function withExplicitModelSelection(configuration) {
  const separator = configuration === "" || configuration.endsWith("\n") ? "" : "\n";
  return `${configuration}${separator}${PACKED_PROOF_MODEL_SELECTION.join("\n")}\n`;
}

/**
 * Parse `npm pack --json` stdout even when lifecycle scripts write before the
 * JSON array (`prepare` prints `sync hooks: …`).
 *
 * @param {string} stdout
 * @returns {unknown}
 */
export function parseNpmPackJson(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end < start) {
    throw new Error("npm pack --json did not emit a JSON array.");
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

/** Require an extracted package license to match the accepted source bytes. */
export function assertPackedLicenseMatches(packedBytes, acceptedBytes) {
  if (!Buffer.isBuffer(packedBytes) || !packedBytes.equals(acceptedBytes)) {
    throw new Error("packed LICENSE does not match the accepted package license source");
  }
}

/** Require an extracted package NOTICE to match the accepted source bytes. */
export function assertPackedNoticeMatches(packedBytes, acceptedBytes) {
  if (!Buffer.isBuffer(packedBytes) || !packedBytes.equals(acceptedBytes)) {
    throw new Error("packed NOTICE does not match the accepted package notice source");
  }
}

/**
 * Parse the optional retained-artifact input shared by installed acceptance
 * helpers. The producer writes directly beneath the package root, so consumers
 * accept one leaf rather than an arbitrary relative path.
 *
 * @param {string[]} argv
 * @returns {{ artifactDirectoryLeaf?: string }}
 */
export function parsePackedCandidateArguments(argv) {
  if (argv.length === 0) return {};
  if (
    argv.length !== 2 ||
    argv[0] !== "--artifact-dir" ||
    isAbsolute(argv[1]) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(argv[1])
  ) {
    throw new Error("expected no arguments or --artifact-dir <safe package-relative leaf>");
  }
  return { artifactDirectoryLeaf: argv[1] };
}

/**
 * Parse the package verifier's optional candidate input and retained output.
 * Each is one package-relative leaf and may be supplied in either order.
 *
 * @param {string[]} argv
 * @returns {{ artifactDirectoryLeaf?: string; outputDirectoryLeaf?: string }}
 */
export function parsePackedVerificationArguments(argv) {
  const parsed = {};
  if (argv.length % 2 !== 0) {
    throw new Error(
      "Packed CLI verification accepts [--artifact-dir <leaf>] [--output-dir <leaf>].",
    );
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--artifact-dir" && flag !== "--output-dir") {
      throw new Error(
        "Packed CLI verification accepts [--artifact-dir <safe leaf>] [--output-dir <safe leaf>].",
      );
    }
    const key = flag === "--artifact-dir" ? "artifactDirectoryLeaf" : "outputDirectoryLeaf";
    if (
      parsed[key] !== undefined ||
      !value ||
      isAbsolute(value) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)
    ) {
      throw new Error(
        "Packed CLI verification accepts [--artifact-dir <safe leaf>] [--output-dir <safe leaf>].",
      );
    }
    parsed[key] = value;
  }
  return parsed;
}

async function resolveSourceRevision(projectRoot, env, runCommand = execute) {
  if (env.CI_COMMIT_SHA !== undefined) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(env.CI_COMMIT_SHA)) {
      throw new Error("CI_COMMIT_SHA must be one full hexadecimal source revision.");
    }
    return env.CI_COMMIT_SHA;
  }
  const revision = (
    await runCommand("git", ["rev-parse", "HEAD"], { cwd: projectRoot, env })
  ).stdout.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(revision)) {
    throw new Error("could not resolve one full local Git source revision.");
  }
  return revision;
}

async function readArchivePackageIdentity(tarball, runCommand = execute) {
  let stdout;
  try {
    ({ stdout } = await runCommand("tar", ["-xOf", tarball, "package/package.json"], {
      maxBuffer: MAX_BUFFER,
      encoding: "buffer",
    }));
  } catch (error) {
    if (error?.details?.limit) throw error;
    throw new Error("packed candidate does not contain a readable package/package.json.", {
      cause: error,
    });
  }
  let packageJson;
  try {
    packageJson = JSON.parse(stdout.toString("utf8"));
  } catch (error) {
    throw new Error("packed candidate package/package.json is not valid JSON.", { cause: error });
  }
  if (
    !packageJson ||
    typeof packageJson !== "object" ||
    Array.isArray(packageJson) ||
    typeof packageJson.name !== "string" ||
    typeof packageJson.version !== "string"
  ) {
    throw new Error("packed candidate package/package.json has no usable name and version.");
  }
  return { name: packageJson.name, version: packageJson.version };
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * Fail unless a fresh clean pack reproduced the candidate bytes exactly.
 *
 * @param {Buffer} candidateBytes
 * @param {Buffer} repeatedBytes
 */
export function assertPackedCandidateReproducible(candidateBytes, repeatedBytes) {
  if (!repeatedBytes.equals(candidateBytes)) {
    throw new Error("clean prepack did not reproduce the exact packed candidate bytes.");
  }
}

/**
 * Retain already-validated packed bytes with the strict release metadata
 * schema. The caller decides whether those bytes are an early candidate or a
 * finally accepted package; this function grants no publication authority.
 *
 * @param {{
 *   projectRoot: string;
 *   artifactRoot: string;
 *   tarball: string;
 *   record: any;
 *   sourceRevision: string;
 * }} input
 */
export async function retainPackedArtifact({
  projectRoot,
  artifactRoot,
  tarball,
  record,
  sourceRevision,
  sourceVersion,
  sourceClean,
}) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceRevision)) {
    throw new Error("retained packed artifact requires one full hexadecimal source revision.");
  }
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const bytes = await readFile(tarball);
  const integrity = sha512Integrity(bytes);
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const expectedFilename = `docsfab-${record?.version}.tgz`;
  if (
    record?.name !== packageJson.name ||
    !isPackedVersionBoundToSource(record?.version, sourceVersion) ||
    sourceVersion !== packageJson.version ||
    typeof sourceClean !== "boolean" ||
    record?.filename !== expectedFilename ||
    record?.integrity !== integrity ||
    record?.shasum !== sha1 ||
    record?.size !== bytes.byteLength ||
    !Number.isSafeInteger(record?.entryCount) ||
    record.entryCount < 1 ||
    !Number.isSafeInteger(record?.unpackedSize) ||
    record.unpackedSize < 1
  ) {
    throw new Error("packed artifact record does not match the exact package bytes and identity.");
  }

  await mkdir(artifactRoot);
  const retainedTarball = join(artifactRoot, "docsfab.tgz");
  await copyFile(tarball, retainedTarball, fsConstants.COPYFILE_EXCL);
  const retainedBytes = await readFile(retainedTarball);
  if (!retainedBytes.equals(bytes) || sha512Integrity(retainedBytes) !== integrity) {
    throw new Error("retained tarball copy does not match the packed artifact.");
  }
  const metadata = {
    schemaVersion: 2,
    artifact: "docsfab.tgz",
    name: record.name,
    version: record.version,
    filename: record.filename,
    integrity,
    sha1,
    size: (await stat(retainedTarball)).size,
    entryCount: record.entryCount,
    unpackedSize: record.unpackedSize,
    sourceRevision,
    sourceVersion,
    sourceClean,
  };
  await writeFile(join(artifactRoot, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  const verified = await verifyReleaseArtifact({
    projectRoot,
    artifactRoot,
    commitTag: `v${record.version}`,
    commitSha: sourceRevision,
  });
  return { ...verified, metadata };
}

/**
 * Return a candidate for an installed-package acceptance helper. With no
 * artifact leaf this packs fresh. With a leaf it validates the retained
 * producer output, independently inspects the archive identity, and snapshots
 * the verified bytes before returning.
 *
 * @param {{
 *   projectRoot: string;
 *   packDestination: string;
 *   env: NodeJS.ProcessEnv;
 *   artifactDirectoryLeaf?: string;
 *   runCommand?: typeof execute;
 * }} input
 * @returns {Promise<{
 *   record: { name: string; version: string; integrity: string; [key: string]: any };
 *   tarball: string;
 *   integrity: string;
 *   sourceRevision: string;
 *   origin: "fresh-pack" | "retained-artifact";
 * }>}
 */
export async function preparePackedCandidate({
  projectRoot,
  packDestination,
  env,
  artifactDirectoryLeaf,
  runCommand = execute,
}) {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const sourceRevision = await resolveSourceRevision(projectRoot, env, runCommand);

  if (artifactDirectoryLeaf === undefined) {
    const finalVersion = env.DOCSFAB_PACKAGE_FINAL_VERSION ?? packageJson.version;
    if (!isPackedVersionBoundToSource(finalVersion, packageJson.version)) {
      throw new Error("final package version is not bound to the source package version.");
    }
    const sourceClean = await readSourceCleanState(projectRoot, env, runCommand);
    const packed = await packDocsFab({
      projectRoot,
      packDestination,
      env,
      runCommand,
      finalVersion,
    });
    const bytes = await readFile(packed.tarball);
    const integrity = sha512Integrity(bytes);
    if (
      packed.record.name !== packageJson.name ||
      packed.record.version !== finalVersion ||
      packed.record.integrity !== integrity ||
      packed.record.size !== bytes.byteLength
    ) {
      throw new Error("freshly packed candidate identity or integrity is invalid.");
    }
    const archiveIdentity = await readArchivePackageIdentity(packed.tarball, runCommand);
    if (archiveIdentity.name !== packageJson.name || archiveIdentity.version !== finalVersion) {
      throw new Error("packed candidate archive identity does not match package.json.");
    }
    return {
      ...packed,
      integrity,
      sourceRevision,
      sourceVersion: packageJson.version,
      sourceClean,
      origin: "fresh-pack",
    };
  }

  if (
    isAbsolute(artifactDirectoryLeaf) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(artifactDirectoryLeaf)
  ) {
    throw new Error("artifact directory must be one safe package-relative leaf.");
  }
  const artifactRoot = resolve(projectRoot, artifactDirectoryLeaf);
  const retainedMetadata = JSON.parse(await readFile(join(artifactRoot, "metadata.json"), "utf8"));
  const verified = await verifyReleaseArtifact({
    projectRoot,
    artifactRoot,
    // This synthetic tag exercises the verifier's final package-version binding. It
    // identifies no publish event and grants no publication authority.
    commitTag: `v${retainedMetadata.version}`,
    commitSha: sourceRevision,
  });
  const tarball = join(packDestination, "docsfab.tgz");
  await copyFile(verified.tarballPath, tarball, fsConstants.COPYFILE_EXCL);
  const snapshot = await readFile(tarball);
  if (sha512Integrity(snapshot) !== verified.integrity) {
    throw new Error("private packed candidate snapshot does not match verified integrity.");
  }
  const archiveIdentity = await readArchivePackageIdentity(tarball, runCommand);
  if (archiveIdentity.name !== verified.name || archiveIdentity.version !== verified.version) {
    throw new Error("packed candidate archive identity does not match verified metadata.");
  }
  return {
    record: {
      name: verified.name,
      version: verified.version,
      integrity: verified.integrity,
      size: snapshot.byteLength,
    },
    tarball,
    integrity: verified.integrity,
    sourceRevision: verified.sourceRevision,
    sourceVersion: verified.sourceVersion,
    sourceClean: verified.sourceClean,
    origin: "retained-artifact",
  };
}

async function readSourceCleanState(projectRoot, env, runCommand) {
  const result = await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: projectRoot,
    env,
  });
  return result.stdout.length === 0;
}

/**
 * Build the exact release tarball from a clean prepack and return its identity.
 *
 * @param {{ projectRoot: string; packDestination: string; env: NodeJS.ProcessEnv; runCommand?: typeof execute }} input
 * @returns {Promise<{ record: any; tarball: string }>}
 */
export async function packDocsFab({
  projectRoot,
  packDestination,
  env,
  runCommand = execute,
  finalVersion,
}) {
  const manifestNames = ["package.json", "package-lock.json", "npm-shrinkwrap.json"];
  const originals = new Map();
  const sourcePackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const version = finalVersion ?? sourcePackage.version;
  if (version !== sourcePackage.version) {
    // Build while the checkout still represents its committed source. The final
    // version is materialized only for npm pack, and the manifests are restored
    // before this function returns.
    await runCommand("npm", ["run", "build"], { cwd: projectRoot, env, maxBuffer: MAX_BUFFER });
  }
  let packed;
  try {
    if (version !== sourcePackage.version) {
      for (const filename of manifestNames) {
        const path = join(projectRoot, filename);
        const original = await readFile(path);
        originals.set(path, original);
        const document = JSON.parse(original.toString("utf8"));
        document.version = version;
        if (document.packages?.[""]) document.packages[""].version = version;
        await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      }
    }
    const args = ["pack", "--json"];
    if (version !== sourcePackage.version) args.push("--ignore-scripts");
    args.push("--pack-destination", packDestination);
    packed = await runCommand("npm", args, { cwd: projectRoot, env, maxBuffer: MAX_BUFFER });
  } finally {
    await Promise.all([...originals].map(([path, bytes]) => writeFile(path, bytes)));
  }
  const records = parseNpmPackJson(packed.stdout);
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error("npm pack did not return exactly one packed DocsFab artifact record.");
  }
  const record = records[0];
  if (!record || typeof record.filename !== "string" || record.filename.length === 0) {
    throw new Error("npm pack returned a packed artifact record without a usable filename.");
  }
  return { record, tarball: join(packDestination, record.filename) };
}

/**
 * Install one packed tarball into an isolated global prefix outside the source
 * tree and return the operator-facing executable and installed package root.
 * Passing `offline: true` forbids any network access so the caller can prove
 * the install completes from a warmed cache alone.
 *
 * @param {{
 *   tarball: string;
 *   installRoot: string;
 *   cwd: string;
 *   env: NodeJS.ProcessEnv;
 *   offline?: boolean;
 *   scope?: string;
 *   name?: string;
 *   runCommand?: typeof execute;
 * }} input
 * @returns {Promise<{ installedPackageRoot: string; executable: string }>}
 */
export async function installPackedDocsFab({
  tarball,
  installRoot,
  cwd,
  env,
  offline = false,
  scope = "",
  name = "docsfab",
  runCommand = execute,
}) {
  const args = ["install", "--global", "--prefix", installRoot];
  if (offline) args.push("--offline");
  args.push(tarball);
  await runCommand("npm", args, { cwd, env, maxBuffer: MAX_BUFFER });
  const installedPackageRoot = scope
    ? join(installRoot, "lib", "node_modules", scope, name)
    : join(installRoot, "lib", "node_modules", name);
  return {
    installedPackageRoot,
    executable: join(installRoot, "bin", name),
  };
}
