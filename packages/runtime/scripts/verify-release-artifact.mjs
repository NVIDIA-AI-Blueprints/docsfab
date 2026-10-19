// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(`Release artifact verification failed: ${message}`);
}

export async function verifyReleaseArtifact({ projectRoot, artifactRoot, commitTag, commitSha }) {
  const canonicalProjectRoot = await realpath(projectRoot);
  const canonicalArtifactRoot = await realpath(artifactRoot);
  const rootMetadata = await lstat(artifactRoot);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    canonicalArtifactRoot !== artifactRoot ||
    !canonicalArtifactRoot.startsWith(`${canonicalProjectRoot}/`)
  ) {
    fail("artifact directory must be one canonical nonsymlink project directory");
  }

  const metadataPath = resolve(artifactRoot, "metadata.json");
  const tarballPath = resolve(artifactRoot, "docsfab.tgz");
  const [metadataFile, tarballFile] = await Promise.all([lstat(metadataPath), lstat(tarballPath)]);
  if (
    !metadataFile.isFile() ||
    metadataFile.isSymbolicLink() ||
    metadataFile.nlink !== 1 ||
    !tarballFile.isFile() ||
    tarballFile.isSymbolicLink() ||
    tarballFile.nlink !== 1
  ) {
    fail("metadata and tarball must be single-link nonsymlink regular files");
  }

  const [packageJson, metadata, tarball] = await Promise.all([
    readFile(resolve(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(metadataPath, "utf8").then(JSON.parse),
    readFile(tarballPath),
  ]);
  const commonKeys = [
    "artifact",
    "entryCount",
    "filename",
    "integrity",
    "name",
    "schemaVersion",
    "sha1",
    "size",
    "sourceRevision",
    "unpackedSize",
    "version",
  ].sort();
  const v2Keys = [...commonKeys, "sourceClean", "sourceVersion"].sort();
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    ![1, 2].includes(metadata.schemaVersion) ||
    JSON.stringify(Object.keys(metadata).sort()) !==
      JSON.stringify(metadata.schemaVersion === 1 ? commonKeys : v2Keys) ||
    metadata.artifact !== "docsfab.tgz"
  ) {
    fail("metadata schema is invalid");
  }
  const sourceVersion = metadata.schemaVersion === 1 ? metadata.version : metadata.sourceVersion;
  if (
    metadata.name !== packageJson.name ||
    sourceVersion !== packageJson.version ||
    (metadata.schemaVersion === 2 && typeof metadata.sourceClean !== "boolean")
  ) {
    fail("metadata name or version does not match package.json");
  }
  if (commitTag !== `v${metadata.version}`) {
    fail("release tag does not exactly match the package version");
  }
  if (
    metadata.sourceRevision !== commitSha ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(metadata.sourceRevision)
  ) {
    fail("artifact source revision does not match this pipeline");
  }
  const expectedFilename = `docsfab-${metadata.version}.tgz`;
  if (
    !Number.isSafeInteger(metadata.size) ||
    metadata.size !== tarball.byteLength ||
    !Number.isSafeInteger(metadata.entryCount) ||
    metadata.entryCount < 1 ||
    !Number.isSafeInteger(metadata.unpackedSize) ||
    metadata.unpackedSize < 1 ||
    metadata.filename !== expectedFilename
  ) {
    fail("artifact metadata values are invalid");
  }
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const sha1 = createHash("sha1").update(tarball).digest("hex");
  if (metadata.integrity !== integrity || metadata.sha1 !== sha1) {
    fail("retained tarball bytes do not match verified integrity metadata");
  }
  return Object.freeze({
    name: metadata.name,
    version: metadata.version,
    sourceRevision: metadata.sourceRevision,
    sourceVersion,
    sourceClean: metadata.schemaVersion === 2 ? metadata.sourceClean : null,
    integrity,
    tarballPath,
  });
}

async function main() {
  const relativeRoot = process.argv[2];
  if (
    !relativeRoot ||
    process.argv.length !== 3 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(relativeRoot)
  ) {
    fail("expected one safe repository-relative artifact directory leaf");
  }
  const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const result = await verifyReleaseArtifact({
    projectRoot,
    artifactRoot: resolve(projectRoot, relativeRoot),
    commitTag: process.env.CI_COMMIT_TAG,
    commitSha: process.env.CI_COMMIT_SHA,
  });
  console.log(
    `Verified exact release artifact ${result.name}@${result.version} from ${result.sourceRevision}.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
