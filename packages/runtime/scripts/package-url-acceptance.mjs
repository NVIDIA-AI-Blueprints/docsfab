#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Install and smoke-test one exact DocsFab package URL from the configured npm
 * registry. Authentication is used only by npm metadata lookup and install;
 * installed CLI commands receive a scrubbed offline environment.
 *
 * Usage: npm run acceptance:package-url -- --version <exact> --output-dir <absolute> [--npm-userconfig <absolute>] [--source-sha <sha> --package-id <id> --pipeline-id <id>]
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceFilename = "package-url-acceptance.json";
const SAFE_CLI_ENVIRONMENT = new Set(["PATH", "LANG", "LC_ALL", "TZ"]);
const SAFE_NPM_ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);
const NPM_AUTH_ENVIRONMENT = new Set(["NPM_TOKEN", "NODE_AUTH_TOKEN"]);

function fail(message) {
  throw new Error(`Package URL acceptance failed: ${message}`);
}

function assertOutsideRoot(root, target, description) {
  const rel = relative(root, target);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    fail(`${description} must be outside the runtime source tree.`);
  }
}

function assertWithinRoot(root, target, description) {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`${description} resolves outside its package root.`);
  }
}

async function canonicalProspectivePath(path) {
  let ancestor = resolve(path);
  const remainder = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(canonicalAncestor, ...remainder.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      remainder.push(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : sep.length)));
      ancestor = parent;
    }
  }
}

function parseArguments(argv) {
  const values = {};
  if (argv.length < 4 || argv.length > 12 || argv.length % 2 !== 0) {
    fail("expected --version and --output-dir, with optional npm config and provenance fields.");
  }
  const keys = new Map([
    ["--version", "version"],
    ["--output-dir", "outputDirectory"],
    ["--npm-userconfig", "npmUserconfig"],
    ["--source-sha", "sourceSha"],
    ["--package-id", "packageId"],
    ["--pipeline-id", "pipelineId"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = keys.get(flag);
    if (!key) fail("received an unsupported option.");
    if (values[key] !== undefined || !argv[index + 1]) {
      fail("expected each required option exactly once.");
    }
    values[key] = argv[index + 1];
  }
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      values.version ?? "",
    )
  ) {
    fail("--version must be one exact semantic version, not a tag or range.");
  }
  if (!isAbsolute(values.outputDirectory ?? "")) fail("--output-dir must be an absolute path.");
  if (values.npmUserconfig !== undefined && !isAbsolute(values.npmUserconfig)) {
    fail("--npm-userconfig must be an absolute path.");
  }
  if (
    values.sourceSha !== undefined &&
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(values.sourceSha)
  ) {
    fail("--source-sha must be one full hexadecimal revision.");
  }
  if (values.packageId !== undefined && !/^\d+$/u.test(values.packageId)) {
    fail("--package-id must be a numeric package identity.");
  }
  if (values.pipelineId !== undefined && !/^\d+$/u.test(values.pipelineId)) {
    fail("--pipeline-id must be a numeric pipeline identity.");
  }
  return {
    version: values.version,
    outputDirectory: resolve(values.outputDirectory),
    npmUserconfig: values.npmUserconfig === undefined ? undefined : resolve(values.npmUserconfig),
    sourceSha: values.sourceSha,
    packageId: values.packageId,
    pipelineId: values.pipelineId,
  };
}

function parseDist(stdout, expectedVersion, registry) {
  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch {
    fail("npm registry metadata was not valid JSON.");
  }
  const dist = metadata?.dist;
  if (metadata?.version !== expectedVersion || typeof dist?.tarball !== "string") {
    fail("registry metadata did not identify the requested exact package version and tarball.");
  }
  let url;
  try {
    url = new URL(dist.tarball);
  } catch {
    fail("registry metadata returned an invalid package URL.");
  }
  const registryUrl = new URL(registry);
  if (registryUrl.protocol !== "https:" || registryUrl.username || registryUrl.password) {
    fail("configured package registry must use HTTPS without URL credentials.");
  }
  const registryPath = registryUrl.pathname.endsWith("/")
    ? registryUrl.pathname
    : `${registryUrl.pathname}/`;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== registryUrl.origin ||
    !url.pathname.startsWith(registryPath)
  ) {
    fail("registry metadata returned a package URL with unsupported credentials or parameters.");
  }
  const integrity = typeof dist.integrity === "string" ? dist.integrity : undefined;
  const shasum = typeof dist.shasum === "string" ? dist.shasum : undefined;
  const integrityData = integrity?.startsWith("sha512-") ? integrity.slice("sha512-".length) : "";
  const integrityBytes = Buffer.from(integrityData, "base64");
  const validIntegrity =
    integrity !== undefined &&
    /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity) &&
    integrityBytes.byteLength === 64 &&
    integrityBytes.toString("base64") === integrityData;
  const validShasum = shasum !== undefined && /^[a-f0-9]{40}$/u.test(shasum);
  if (!validIntegrity && !validShasum)
    fail("registry metadata did not include a valid package digest.");
  return {
    version: metadata.version,
    tarballUrl: dist.tarball,
    integrity: validIntegrity ? integrity : undefined,
    shasum: validShasum ? shasum : undefined,
    gitHead: /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(metadata.gitHead ?? "")
      ? metadata.gitHead
      : undefined,
  };
}

function offlineEnvironment(base, { home, stateHome }) {
  const filtered = Object.fromEntries(
    Object.entries(base).filter(([name]) => SAFE_CLI_ENVIRONMENT.has(name)),
  );
  return {
    ...filtered,
    HOME: home,
    XDG_STATE_HOME: stateHome,
    TMPDIR: dirname(stateHome),
    PI_OFFLINE: "1",
  };
}

function parseNpmPackJson(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end < start) fail("npm pack did not emit a JSON result.");
  let records;
  try {
    records = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    fail("npm pack emitted invalid JSON.");
  }
  if (!Array.isArray(records) || records.length !== 1 || !records[0]) {
    fail("npm pack did not return exactly one package record.");
  }
  return records[0];
}

function calculateDownloadedDigest(bytes) {
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return { sha1, integrity, size: bytes.byteLength };
}

function assertDownloadedDigestMatches(actual, candidate) {
  if (candidate.shasum && candidate.shasum !== actual.sha1) {
    fail("downloaded package bytes do not match the registry SHA-1 digest.");
  }
  if (candidate.integrity && candidate.integrity !== actual.integrity) {
    fail("downloaded package bytes do not match the registry SHA-512 integrity.");
  }
}

async function runNpm(args, options) {
  try {
    const result = await execute("npm", args, options);
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    const exitCode = Number.isInteger(error?.code) ? error.code : (error?.status ?? 1);
    return { stdout: typeof error?.stdout === "string" ? error.stdout : "", exitCode };
  }
}

async function runCli(executable, args, { cwd, env }) {
  try {
    const result = await execute(executable, args, { cwd, env });
    return { exitCode: 0, stdout: result.stdout };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : (error?.status ?? 1),
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
    };
  }
}

function parseArchiveMember(name, type) {
  if (/[\\\0-\x1f\x7f]/u.test(name)) fail("package archive contains an unsafe member path.");
  if (name === "package/" && type === "d") return { directory: true, path: "" };
  if (!name.startsWith("package/"))
    fail("package archive contains a member outside its package root.");
  const directory = name.endsWith("/");
  if ((type === "d") !== directory || (type !== "d" && type !== "-")) {
    fail("package archive contains a non-regular member type.");
  }
  const path = directory ? name.slice("package/".length, -1) : name.slice("package/".length);
  const segments = path.split("/");
  if (
    !path ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    segments[0] === "node_modules"
  ) {
    fail("package archive contains an unsafe or unsupported member path.");
  }
  return { directory, path };
}

async function regularFilePaths(root, { prefix = "", ignoreRootNodeModules = false } = {}) {
  const paths = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (ignoreRootNodeModules && prefix === "" && entry.name === "node_modules") continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isSymbolicLink())
      fail("installed package tree contains an unexpected symbolic link.");
    if (entry.isDirectory()) {
      paths.push(
        ...(await regularFilePaths(root, { prefix: relativePath, ignoreRootNodeModules })),
      );
    } else if (entry.isFile()) paths.push(relativePath);
    else fail("installed package tree contains an unsupported filesystem entry.");
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink())
      fail("installed package tree contains an unexpected symbolic link.");
  }
  return paths;
}

async function assertInstalledTreeMatchesArchive(archivePath, installedRoot, extractionRoot) {
  const [archiveList, verboseList] = await Promise.all([
    execute("tar", ["-tzf", archivePath], { encoding: "utf8" }),
    execute("tar", ["-tvzf", archivePath], { encoding: "utf8" }),
  ]);
  const memberNames = archiveList.stdout.split(/\r?\n/u).filter(Boolean);
  const verboseLines = verboseList.stdout.split(/\r?\n/u).filter(Boolean);
  if (memberNames.length !== verboseLines.length) {
    fail("package archive member type listing is inconsistent.");
  }

  const canonicalInstalledRoot = await realpath(installedRoot);
  const canonicalExtractionRoot = await realpath(extractionRoot);
  const expectedFiles = new Set();
  const seenMembers = new Set();
  for (let index = 0; index < memberNames.length; index += 1) {
    const member = parseArchiveMember(memberNames[index], verboseLines[index].charAt(0));
    const memberKey = `${member.directory ? "directory" : "file"}:${member.path}`;
    if (seenMembers.has(memberKey)) fail("package archive contains a duplicate member path.");
    seenMembers.add(memberKey);
    if (member.directory) continue;
    if (expectedFiles.has(member.path)) fail("package archive contains a duplicate file member.");
    expectedFiles.add(member.path);
  }

  // Validate the complete archive listing before allowing tar to write any
  // member. Only regular files and directories beneath package/ are accepted.
  await execute(
    "tar",
    ["-xzf", archivePath, "--strip-components=1", "-C", canonicalExtractionRoot],
    { encoding: "utf8" },
  );

  for (const path of expectedFiles) {
    const extractedPath = join(canonicalExtractionRoot, ...path.split("/"));
    const installedPath = join(canonicalInstalledRoot, ...path.split("/"));
    const canonicalExtractedPath = await realpath(extractedPath);
    const canonicalInstalledPath = await realpath(installedPath);
    assertWithinRoot(canonicalExtractionRoot, canonicalExtractedPath, "archive member");
    assertWithinRoot(canonicalInstalledRoot, canonicalInstalledPath, "installed package member");
    const extractedStat = await lstat(extractedPath);
    const entryStat = await lstat(installedPath);
    if (!extractedStat.isFile() || extractedStat.isSymbolicLink()) {
      fail("verified archive member is not a regular file after extraction.");
    }
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      fail("installed package member is not a regular file.");
    }
    const [archiveMember, installedBytes] = await Promise.all([
      readFile(extractedPath),
      readFile(installedPath),
    ]);
    if (!archiveMember.equals(installedBytes)) {
      fail("installed package content differs from the digest-verified archive.");
    }
  }

  const actualFiles = new Set(
    await regularFilePaths(canonicalInstalledRoot, { ignoreRootNodeModules: true }),
  );
  const extractedFiles = new Set(await regularFilePaths(canonicalExtractionRoot));
  if (
    actualFiles.size !== expectedFiles.size ||
    extractedFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((path) => !actualFiles.has(path) || !extractedFiles.has(path))
  ) {
    fail("installed or extracted package file set differs from the digest-verified archive.");
  }
}

function assertPassed(result, name) {
  if (result.exitCode !== 0) fail(`${name} exited with status ${result.exitCode}.`);
}

async function main(argv = process.argv.slice(2)) {
  const { version, outputDirectory, npmUserconfig, sourceSha, packageId, pipelineId } =
    parseArguments(argv);
  const canonicalPackageRoot = await realpath(packageRoot);
  assertOutsideRoot(canonicalPackageRoot, outputDirectory, "evidence output");
  const prospectiveOutputRoot = await canonicalProspectivePath(outputDirectory);
  assertOutsideRoot(canonicalPackageRoot, prospectiveOutputRoot, "evidence output");
  await mkdir(outputDirectory, { recursive: true });
  const canonicalOutputRoot = await realpath(outputDirectory);
  assertOutsideRoot(canonicalPackageRoot, canonicalOutputRoot, "evidence output");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (typeof manifest.publishConfig?.registry !== "string") {
    fail("package.json does not declare its npm registry.");
  }
  const outputRoot = canonicalOutputRoot;
  const evidencePath = join(outputRoot, evidenceFilename);
  const canonicalTempDirectory = await canonicalProspectivePath(tmpdir());
  assertOutsideRoot(canonicalPackageRoot, canonicalTempDirectory, "temporary directory");
  const temporaryRoot = await realpath(
    await mkdtemp(join(canonicalTempDirectory, "docsfab-package-url-")),
  );
  assertOutsideRoot(canonicalPackageRoot, temporaryRoot, "temporary directory");
  const installRoot = join(temporaryRoot, "prefix");
  const npmCache = join(temporaryRoot, "npm-cache");
  const npmGlobalConfig = join(temporaryRoot, "global.npmrc");
  const outsideRoot = join(temporaryRoot, "outside-source");
  const home = join(temporaryRoot, "home");
  const stateHome = join(temporaryRoot, "state");
  const result = {
    schemaVersion: 1,
    status: "failed",
    package: { name: manifest.name, requestedVersion: version },
    registry: manifest.publishConfig.registry,
    host: { platform: process.platform, architecture: process.arch, node: process.version },
    provenance: {
      operatorSupplied: {
        ...(sourceSha ? { sourceSha } : {}),
        ...(packageId ? { packageId } : {}),
        ...(pipelineId ? { pipelineId } : {}),
      },
    },
    commands: [],
  };

  try {
    await mkdir(outputRoot, { recursive: true });
    await mkdir(installRoot);
    await mkdir(npmCache);
    await mkdir(outsideRoot);
    await mkdir(home, { mode: 0o700 });
    await mkdir(stateHome, { mode: 0o700 });
    await writeFile(npmGlobalConfig, "", { flag: "wx", mode: 0o600 });

    const npmEnvironment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => SAFE_NPM_ENVIRONMENT.has(name)),
      ),
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => NPM_AUTH_ENVIRONMENT.has(name)),
      ),
      npm_config_cache: npmCache,
      npm_config_globalconfig: npmGlobalConfig,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_ignore_scripts: "true",
      npm_config_engine_strict: "true",
      ...(npmUserconfig ? { npm_config_userconfig: npmUserconfig } : {}),
    };
    const npmVersion = await runNpm(["--version"], { cwd: outsideRoot, env: npmEnvironment });
    result.commands.push({
      name: "npm-version",
      command: "npm --version",
      exitCode: npmVersion.exitCode,
    });
    assertPassed(npmVersion, "npm --version");
    result.host.npm = npmVersion.stdout.trim();

    const metadataCommand = [
      "view",
      `${manifest.name}@${version}`,
      "version",
      "dist",
      "gitHead",
      "--json",
      `--registry=${manifest.publishConfig.registry}`,
      "--loglevel=error",
    ];
    const metadataResult = await runNpm(metadataCommand, { cwd: outsideRoot, env: npmEnvironment });
    result.commands.push({
      name: "resolve-package-metadata",
      command: `npm view ${manifest.name}@${version} version dist gitHead --json --registry=<package-registry> --loglevel=error`,
      exitCode: metadataResult.exitCode,
    });
    assertPassed(metadataResult, "npm package metadata lookup");
    const candidate = parseDist(metadataResult.stdout, version, manifest.publishConfig.registry);
    result.provenance.registryReported = { gitHead: candidate.gitHead };
    if (sourceSha && candidate.gitHead && candidate.gitHead !== sourceSha) {
      fail("registry package source revision does not match the supplied source SHA.");
    }
    result.package = {
      name: manifest.name,
      version: candidate.version,
      tarballUrl: candidate.tarballUrl,
      registryDigests: {
        integrity: candidate.integrity,
        shasum: candidate.shasum,
      },
    };

    const installArgs = [
      "install",
      "--global",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--engine-strict",
      candidate.tarballUrl,
    ];
    const installCommand = `npm install --global --prefix <isolated-prefix> --ignore-scripts --engine-strict ${candidate.tarballUrl}`;
    const installResult = await runNpm(installArgs, { cwd: outsideRoot, env: npmEnvironment });
    result.commands.push({
      name: "install-package-url",
      command: installCommand,
      exitCode: installResult.exitCode,
    });
    assertPassed(installResult, "npm install of package URL");

    const downloadRoot = join(temporaryRoot, "verified-download");
    await mkdir(downloadRoot);
    const packArgs = [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      downloadRoot,
      candidate.tarballUrl,
    ];
    const packResult = await runNpm(packArgs, { cwd: outsideRoot, env: npmEnvironment });
    result.commands.push({
      name: "download-package-bytes",
      command: `npm pack --json --ignore-scripts --pack-destination <verified-download> ${candidate.tarballUrl}`,
      exitCode: packResult.exitCode,
    });
    assertPassed(packResult, "npm pack of the package URL for byte verification");
    const packRecord = parseNpmPackJson(packResult.stdout);
    if (
      packRecord.name !== manifest.name ||
      packRecord.version !== version ||
      typeof packRecord.filename !== "string" ||
      !/^docsfab-[A-Za-z0-9][A-Za-z0-9.+_-]*\.tgz$/u.test(packRecord.filename)
    ) {
      fail("npm pack returned an unexpected package identity or unsafe filename.");
    }
    const downloadedBytes = await readFile(join(downloadRoot, packRecord.filename));
    result.downloadedBytes = calculateDownloadedDigest(downloadedBytes);
    result.checks ??= [];
    try {
      assertDownloadedDigestMatches(result.downloadedBytes, candidate);
      result.checks.push({ name: "downloaded-bytes-match-registry-digest", status: "passed" });
    } catch (error) {
      result.checks.push({ name: "downloaded-bytes-match-registry-digest", status: "failed" });
      throw error;
    }

    const installedPackageRoot = join(installRoot, "lib", "node_modules", manifest.name);
    const extractedPackageRoot = join(temporaryRoot, "verified-extracted");
    await mkdir(extractedPackageRoot);
    try {
      await assertInstalledTreeMatchesArchive(
        join(downloadRoot, packRecord.filename),
        installedPackageRoot,
        extractedPackageRoot,
      );
      result.checks ??= [];
      result.checks.push({ name: "installed-tree-matches-verified-archive", status: "passed" });
    } catch (error) {
      result.checks ??= [];
      result.checks.push({ name: "installed-tree-matches-verified-archive", status: "failed" });
      throw error;
    }
    const installedManifest = JSON.parse(
      await readFile(join(installedPackageRoot, "package.json"), "utf8"),
    );
    if (installedManifest.name !== manifest.name || installedManifest.version !== version) {
      fail("installed manifest does not match the requested exact package identity.");
    }
    result.installed = {
      name: installedManifest.name,
      version: installedManifest.version,
      engines: installedManifest.engines,
      executable: "<isolated-prefix>/bin/docsfab",
    };

    const cliEnvironment = offlineEnvironment(process.env, { home, stateHome });
    const executable = join(installRoot, "bin", "docsfab");
    const checks = [
      ["version", ["--version"]],
      ["help", ["--help"]],
      ["list", ["list"]],
      ["offline-self-test", ["test", "--json"]],
    ];
    for (const [name, args] of checks) {
      const commandResult = await runCli(executable, args, {
        cwd: outsideRoot,
        env: cliEnvironment,
      });
      result.commands.push({
        name,
        command: `docsfab ${args.join(" ")}`,
        exitCode: commandResult.exitCode,
      });
      assertPassed(commandResult, `docsfab ${args.join(" ")}`);
      if (name === "version" && commandResult.stdout.trim() !== version) {
        fail("installed docsfab --version does not match the requested exact version.");
      }
      if (name === "offline-self-test") {
        let testRecord;
        try {
          testRecord = JSON.parse(commandResult.stdout);
        } catch {
          fail("docsfab test --json did not emit valid JSON.");
        }
        const selfTestCommand = result.commands.at(-1);
        selfTestCommand.resultKind = testRecord.kind;
        selfTestCommand.resultStatus = testRecord.status;
        if (testRecord.kind !== "docsfab-offline-product-test" || testRecord.status !== "passed") {
          fail("docsfab test --json did not report a passed offline product test.");
        }
      }
    }
    result.status = "passed";
    result.isolation = {
      prefix: "temporary and outside source tree",
      cache: "empty temporary npm cache",
      installedCommands: "offline with host credentials and npm auth configuration removed",
      lifecycleScripts: "disabled for metadata, install, and byte-verification commands",
      enginePolicy: "strict; npm install uses --engine-strict",
      sourceCheckout: "not used for install or CLI execution",
    };
    await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`PASS package URL installation acceptance for ${manifest.name}@${version}`);
    console.log(`Evidence: ${evidencePath}`);
  } catch (error) {
    // Do not forward npm stderr/stdout or arbitrary child-process errors: they
    // can include host configuration, credentials, or private filesystem paths.
    const safeMessage =
      error instanceof Error && error.message.startsWith("Package URL acceptance failed:")
        ? error.message
        : "Package URL acceptance failed: a required command or evidence check failed; inspect its named exit status without sharing raw npm output.";
    result.failure = safeMessage;
    try {
      await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      // Preserve the original acceptance failure when evidence already exists or cannot be written.
    }
    console.error(safeMessage);
    process.exitCode = 1;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message =
      error instanceof Error && error.message.startsWith("Package URL acceptance failed:")
        ? error.message
        : "Package URL acceptance failed before a command could be recorded.";
    console.error(message);
    process.exitCode = 1;
  });
}

export { offlineEnvironment, parseArguments, parseDist };
