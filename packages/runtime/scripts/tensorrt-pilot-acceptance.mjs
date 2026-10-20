#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prepare a staged TensorRT acceptance record for one explicit retained
 * package. Only Stage A can pass here: it runs the installed CLI offline.
 * Invented fixture checks are useful preparation, never a customer-repository,
 * model-backed, editorial, or WSL qualification.
 *
 * Usage: node scripts/tensorrt-pilot-acceptance.mjs
 *   --candidate-root <absolute source checkout> --dependency-cache <absolute npm cache>
 *   --artifact-dir <retained leaf>
 *   --candidate <safe evidence leaf> --run <safe evidence leaf>
 * The selected cache is read only; private state receives only _cacache content
 * and index data. npmrc files, logs, inherited credentials, and network access
 * are excluded from installed preparation.
 *
 * The candidate root must be the checkout whose HEAD was packed. Output is an
 * unused ignored .docsfab/pilots/tensorrt/<candidate>/<run> directory beside
 * this harness, never the candidate checkout or an operator's home.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveLimitDefinitions } from "../src/config/limit-resolution.js";
import { parsePackedCandidateArguments, preparePackedCandidate } from "./lib/packed-cli.mjs";
import { qualifiedInstalledVersionIdentity } from "./lib/installed-version-identity.mjs";

const execute = promisify(execFile);
const runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(runtimeRoot, "../..");
const fixtureRoot = resolve(runtimeRoot, "test/fixtures/tensorrt-pilot");
const OUTPUT_LIMIT = "tensorrtPilot.commandOutputBytes";
const TIMEOUT_LIMIT = "tensorrtPilot.commandTimeoutMs";
const MANIFEST_LIMIT = "tensorrtPilot.installedManifestBytes";
const TARGET_REFERENCE = Object.freeze({
  revision: "ad0af131a100d09cbfc15cf1f80644af7d8e2789",
  syntheticPathShapes: [
    "documentation/tensorrt/11.4.0/c-api/functions_~.html",
    "documentation/tensorrt/11.4.0/c-api/functions_func_~.html",
    ".docsfab/mr-descriptions/!75.md",
  ],
  status: "historical-oracle-not-executed",
});

class PilotFailure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PilotFailure";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PilotFailure(code, message, details);
}

function safeLeaf(value, flag) {
  try {
    parsePackedCandidateArguments(["--artifact-dir", value]);
  } catch {
    fail("pilot-unsafe-leaf", `${flag} requires one safe leaf.`);
  }
  return value;
}

/** Parse only explicit retained-candidate and evidence inputs. */
export function parsePilotArguments(argv) {
  const keys = new Map([
    ["--candidate-root", "candidateRoot"],
    ["--dependency-cache", "dependencyCacheRoot"],
    ["--artifact-dir", "artifactDirectoryLeaf"],
    ["--candidate", "candidateLeaf"],
    ["--run", "runLeaf"],
  ]);
  const parsed = {};
  if (argv.length % 2 !== 0)
    fail(
      "pilot-arguments",
      "Expected --candidate-root, --dependency-cache, --artifact-dir, --candidate and --run pairs.",
    );
  for (let index = 0; index < argv.length; index += 2) {
    const name = keys.get(argv[index]);
    if (!name || parsed[name] !== undefined || !argv[index + 1]) {
      fail(
        "pilot-arguments",
        "Expected each of --candidate-root, --dependency-cache, --artifact-dir, --candidate and --run exactly once.",
      );
    }
    parsed[name] = argv[index + 1];
  }
  for (const [flag, key] of keys) {
    if (!parsed[key])
      fail(
        "pilot-arguments",
        `${flag} is required; preparation never packs fresh or chooses latest.`,
      );
  }
  if (!isAbsolute(parsed.candidateRoot))
    fail("pilot-candidate-root", "--candidate-root must be an absolute source checkout path.");
  if (!isAbsolute(parsed.dependencyCacheRoot))
    fail("pilot-dependency-cache", "--dependency-cache must be an absolute local npm cache path.");
  safeLeaf(parsed.artifactDirectoryLeaf, "--artifact-dir");
  safeLeaf(parsed.candidateLeaf, "--candidate");
  safeLeaf(parsed.runLeaf, "--run");
  return parsed;
}

/** Carry only environment variables needed by offline local child processes. */
export function pilotChildEnvironment(
  base,
  { home, stateHome, cache, npmUserConfig, npmGlobalConfig },
) {
  return {
    PATH: base.PATH ?? "",
    LANG: base.LANG ?? "C",
    HOME: home,
    XDG_STATE_HOME: stateHome,
    DOCSFAB_STATE_DIR: stateHome,
    DOCSFAB_CONFIG_ROOT: join(stateHome, "config"),
    TMPDIR: join(stateHome, "tmp"),
    PI_OFFLINE: "1",
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: npmUserConfig,
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_cache: cache,
  };
}

let cachedCatalog;

/** Resolve generated canonical limits in a plain Node script. */
function limit(name) {
  if (!cachedCatalog) {
    const catalog = JSON.parse(awaitlessReadCatalog());
    cachedCatalog = Object.entries(catalog.limits ?? {}).map(([entryName, entry]) => ({
      name: entryName,
      ...entry,
    }));
  }
  const resolved = resolveLimitDefinitions(cachedCatalog, { environment: process.env });
  const entry = resolved.find((item) => item.name === name);
  if (!entry)
    fail(
      "pilot-limit-missing",
      `${name} is missing from generated config/limits.catalog.json; run npm run generate:limits.`,
    );
  return entry;
}

function awaitlessReadCatalog() {
  // Imported lazily because injected offline test boundaries do not need the
  // generated catalog before the T12 owner fragment is registered.
  const path = join(repositoryRoot, "config", "limits.catalog.json");
  return readFileSync(path, "utf8");
}

/** Keep a bound failure's code, observation and scope without child output. */
function refuseLimit(bound, observed, scope) {
  fail(
    bound.refusal,
    `${bound.refusal}: ${observed} exceeds ${bound.name} = ${bound.value} ${bound.unit} (scope: ${scope}). ${bound.remediation}`,
    {
      limit: bound.name,
      observed,
      scope,
      bound: bound.value,
      remediation: bound.remediation,
    },
  );
}

async function readInstalledManifest(path) {
  const bound = limit(MANIFEST_LIMIT);
  const scope = "one installed package.json in the isolated prefix";
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(
      "pilot-installed-manifest-type",
      "Installed package.json must be one regular file in the isolated prefix.",
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      fail("pilot-installed-manifest-race", "Installed package.json changed while it was opened.");
    }
    if (opened.size > bound.value) refuseLimit(bound, opened.size, scope);
    const bytes = Buffer.alloc(bound.value + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > bound.value) refuseLimit(bound, offset, scope);
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      after.size !== offset ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    ) {
      fail("pilot-installed-manifest-race", "Installed package.json changed while it was read.");
    }
    try {
      return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    } catch {
      fail("pilot-installed-manifest", "Installed package.json is not valid JSON.");
    }
  } finally {
    await handle.close();
  }
}

/** Test the same child boundary with small injected bounds; production resolves its canonical catalog entries. */
export async function executeBoundedPilotChild(command, args, options, { timeout, output }) {
  const startedAt = Date.now();
  const { allowExitCode, ...execution } = options;
  try {
    return await execute(command, args, {
      ...execution,
      timeout: timeout.value,
      maxBuffer: output.value,
    });
  } catch (error) {
    if (allowExitCode !== undefined && error?.code === allowExitCode) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: allowExitCode };
    }
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      refuseLimit(output, output.value + 1, "one local subprocess stream; observed minimum");
    }
    if (error?.killed || error?.code === "ETIMEDOUT") {
      refuseLimit(timeout, Date.now() - startedAt, "one local subprocess wall duration");
    }
    fail(
      "pilot-child-failed",
      `Required local ${command} command failed; no child output is retained.`,
    );
  }
}

async function boundedChild(command, args, options) {
  return executeBoundedPilotChild(command, args, options, {
    timeout: limit(TIMEOUT_LIMIT),
    output: limit(OUTPUT_LIMIT),
  });
}

async function assertCanonicalDirectory(path, label) {
  const metadata = await lstat(path);
  const canonical = await realpath(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== path) {
    fail("pilot-unsafe-directory", `${label} must be one canonical nonsymlink directory.`);
  }
  return canonical;
}

function pathsOverlap(left, right) {
  const isWithin = (parent, child) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return isWithin(left, right) || isWithin(right, left);
}

async function assertCredentialFreeIndexFile(path) {
  const sensitiveFields = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "password",
    "token",
    "secret",
    "credential",
    "credentials",
    "_auth",
    "_authtoken",
  ];
  const sensitiveQueryNames = new Set([
    "token",
    "access_token",
    "auth",
    "password",
    "secret",
    "credential",
  ]);
  const schemeMarker = "://";
  const schemeOverlap = schemeMarker.length - 1;
  const decoder = new StringDecoder("utf8");
  let schemeTail = "";
  let urlState = "text";
  let queryName = "";
  let queryNamePossible = true;
  let inString = false;
  let escaped = false;
  let unicodeDigits = 0;
  let unicodeValue = 0;
  let fieldCandidate = "";
  let possibleFields = sensitiveFields;
  const refuseCredential = () =>
    fail(
      "pilot-dependency-cache-credentials",
      "Selected npm cache contains credential-bearing index metadata; use a credential-free dependency cache.",
    );
  const checkQueryName = () => {
    if (queryNamePossible && sensitiveQueryNames.has(queryName)) refuseCredential();
  };
  const scanUrlCharacter = (character) => {
    if (urlState === "authority") {
      if (character === "@") refuseCredential();
      if (character === "?") {
        urlState = "query-name";
        queryName = "";
        queryNamePossible = true;
      } else if (character === "/") {
        urlState = "path";
      } else if (character === "#") {
        urlState = "fragment";
      } else if (/["'<>\s]/u.test(character)) {
        urlState = "text";
      }
      return;
    }
    if (urlState === "path") {
      if (character === "?") {
        urlState = "query-name";
        queryName = "";
        queryNamePossible = true;
      } else if (character === "#") {
        urlState = "fragment";
      } else if (/["'<>\s]/u.test(character)) {
        urlState = "text";
      }
      return;
    }
    if (urlState === "fragment") return;
    if (urlState === "query-name") {
      if (character === "=") {
        checkQueryName();
        urlState = "query-value";
      } else if (character === "&") {
        checkQueryName();
        queryName = "";
        queryNamePossible = true;
      } else if (character === "#") {
        checkQueryName();
        urlState = "fragment";
      } else if (/["'<>\s]/u.test(character)) {
        checkQueryName();
        urlState = "text";
      } else if (character === "%") {
        refuseCredential();
      } else if (queryNamePossible) {
        const next = `${queryName}${character.toLowerCase()}`;
        if ([...sensitiveQueryNames].some((name) => name.startsWith(next))) queryName = next;
        else {
          queryName = "";
          queryNamePossible = false;
        }
      }
      return;
    }
    if (urlState === "query-value") {
      if (character === "&") {
        urlState = "query-name";
        queryName = "";
        queryNamePossible = true;
      } else if (character === "#") {
        urlState = "fragment";
      } else if (/["'<>\s]/u.test(character)) {
        urlState = "text";
      }
      return;
    }
    const schemeText = `${schemeTail}${character}`;
    if (schemeText.endsWith(schemeMarker)) {
      urlState = "authority";
      schemeTail = "";
    } else {
      schemeTail = schemeText.slice(-schemeOverlap);
    }
  };
  const scanDecodedStringCharacter = (character) => {
    if (possibleFields.length > 0) {
      fieldCandidate += character.toLowerCase();
      possibleFields = possibleFields.filter((field) => field.startsWith(fieldCandidate));
    }
    scanUrlCharacter(character);
  };
  const scanRawCharacter = (character) => {
    if (!inString) {
      if (character === '"') {
        inString = true;
        escaped = false;
        unicodeDigits = 0;
        fieldCandidate = "";
        possibleFields = sensitiveFields;
        urlState = "text";
        schemeTail = "";
      }
      return;
    }
    if (unicodeDigits > 0) {
      if (!/[0-9a-f]/iu.test(character))
        fail(
          "pilot-dependency-cache-index",
          "Selected npm cache index contains malformed JSON string escapes.",
        );
      unicodeValue = unicodeValue * 16 + Number.parseInt(character, 16);
      unicodeDigits -= 1;
      if (unicodeDigits === 0) scanDecodedStringCharacter(String.fromCharCode(unicodeValue));
      return;
    }
    if (escaped) {
      escaped = false;
      if (character === "u") {
        unicodeDigits = 4;
        unicodeValue = 0;
        return;
      }
      const decoded = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      }[character];
      if (decoded === undefined)
        fail(
          "pilot-dependency-cache-index",
          "Selected npm cache index contains malformed JSON string escapes.",
        );
      scanDecodedStringCharacter(decoded);
      return;
    }
    if (character === "\\") {
      escaped = true;
      return;
    }
    if (character === '"') {
      if (possibleFields.includes(fieldCandidate)) refuseCredential();
      if (urlState === "query-name") checkQueryName();
      inString = false;
      urlState = "text";
      schemeTail = "";
      return;
    }
    if (character.codePointAt(0) < 0x20)
      fail(
        "pilot-dependency-cache-index",
        "Selected npm cache index contains malformed JSON string data.",
      );
    scanDecodedStringCharacter(character);
  };
  try {
    for await (const chunk of createReadStream(path)) {
      for (const character of decoder.write(chunk)) scanRawCharacter(character);
    }
    for (const character of decoder.end()) scanRawCharacter(character);
    if (inString || escaped || unicodeDigits > 0)
      fail(
        "pilot-dependency-cache-index",
        "Selected npm cache index contains an incomplete JSON string.",
      );
  } catch (error) {
    if (error instanceof PilotFailure) throw error;
    fail("pilot-dependency-cache-index", "Selected npm cache index is unreadable.");
  }
}

async function assertSafeCacheTree(directory, { inspectIndex = false } = {}) {
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  ) {
    fail(
      "pilot-dependency-cache-type",
      "Selected npm dependency cache must contain canonical directories only.",
    );
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertSafeCacheTree(path, { inspectIndex });
    else if (entry.isFile()) {
      const file = await lstat(path);
      if (file.isSymbolicLink() || file.nlink !== 1 || (await realpath(path)) !== path) {
        fail(
          "pilot-dependency-cache-type",
          "Selected npm dependency cache must contain single-link regular files only.",
        );
      }
      if (inspectIndex) {
        await assertCredentialFreeIndexFile(path);
      }
    } else {
      fail(
        "pilot-dependency-cache-type",
        "Selected npm dependency cache contains a nonregular entry.",
      );
    }
  }
}

async function digestTree(root) {
  const digest = createHash("sha256");
  async function visit(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(directory, entry.name);
      const name = join(prefix, entry.name);
      digest.update(name);
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.isFile()) {
        for await (const chunk of createReadStream(path)) digest.update(chunk);
      } else
        fail(
          "pilot-dependency-cache-type",
          "Selected npm dependency cache contains a nonregular entry.",
        );
    }
  }
  await visit(root);
  return digest.digest("hex");
}

async function copyCacheTree(source, destination) {
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(source)) !== source) {
    fail("pilot-dependency-cache-type", "Selected npm dependency cache changed during snapshot.");
  }
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyCacheTree(from, to);
    else if (entry.isFile()) {
      const before = await lstat(from);
      if (before.isSymbolicLink() || before.nlink !== 1 || (await realpath(from)) !== from) {
        fail(
          "pilot-dependency-cache-type",
          "Selected npm dependency cache changed during snapshot.",
        );
      }
      const input = await open(from, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = await input.stat();
      await input.close();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        fail(
          "pilot-dependency-cache-type",
          "Selected npm dependency cache changed during snapshot.",
        );
      }
      await pipeline(
        createReadStream(from, { flags: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW }),
        createWriteStream(to, {
          flags:
            fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          mode: 0o600,
        }),
      );
      const after = await lstat(from);
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino
      ) {
        fail(
          "pilot-dependency-cache-changed",
          "Selected npm dependency cache changed while it was snapshotted.",
        );
      }
    } else
      fail(
        "pilot-dependency-cache-type",
        "Selected npm dependency cache contains a nonregular entry.",
      );
  }
}

/** Copy only npm's content-addressed cache into private, per-run state. */
export async function snapshotDependencyCache({
  dependencyCacheRoot,
  candidateRoot,
  evidenceRoot,
  destination,
}) {
  if (!isAbsolute(dependencyCacheRoot))
    fail("pilot-dependency-cache", "--dependency-cache must be an absolute local npm cache path.");
  await assertCanonicalDirectory(dependencyCacheRoot, "Selected npm dependency cache");
  for (const protectedPath of [candidateRoot, evidenceRoot, destination]) {
    if (
      pathsOverlap(dependencyCacheRoot, protectedPath) ||
      pathsOverlap(protectedPath, dependencyCacheRoot)
    ) {
      fail(
        "pilot-dependency-cache-overlap",
        "Selected npm dependency cache must be separate from source and private run state.",
      );
    }
  }
  const source = join(dependencyCacheRoot, "_cacache");
  await assertCanonicalDirectory(source, "Selected npm content cache");
  const content = join(source, "content-v2");
  const index = join(source, "index-v5");
  await assertSafeCacheTree(content);
  await assertSafeCacheTree(index, { inspectIndex: true });
  await assertCanonicalDirectory(destination, "Private npm cache");
  const privateCacache = join(destination, "_cacache");
  await mkdir(privateCacache, { mode: 0o700 });
  for (const name of ["content-v2", "index-v5"]) {
    await copyCacheTree(join(source, name), join(privateCacache, name));
  }
  await assertSafeCacheTree(join(privateCacache, "content-v2"));
  await assertSafeCacheTree(join(privateCacache, "index-v5"), { inspectIndex: true });
  const snapshotDigest = createHash("sha256");
  const sourceDigest = createHash("sha256");
  for (const name of ["content-v2", "index-v5"]) {
    snapshotDigest.update(name);
    snapshotDigest.update(await digestTree(join(privateCacache, name)));
    sourceDigest.update(name);
    sourceDigest.update(await digestTree(join(source, name)));
  }
  const snapshotSha256 = snapshotDigest.digest("hex");
  if (snapshotSha256 !== sourceDigest.digest("hex")) {
    fail(
      "pilot-dependency-cache-changed",
      "Selected npm dependency cache changed while it was snapshotted.",
    );
  }
  return { snapshotSha256 };
}

export async function installPilotCandidate({ tarball, installRoot, cwd, env, runCommand }) {
  try {
    await runCommand(
      "npm",
      ["install", "--global", "--prefix", installRoot, "--offline", tarball],
      {
        cwd,
        env,
      },
    );
  } catch (error) {
    if (error instanceof PilotFailure && error.details?.limit) throw error;
    fail(
      "pilot-dependency-cache-incomplete",
      "Offline installation could not resolve the retained package from the selected dependency cache; warm a credential-free local npm cache for this package and retry.",
    );
  }
  return {
    installedPackageRoot: join(installRoot, "lib", "node_modules", "docsfab"),
    executable: join(installRoot, "bin", "docsfab"),
  };
}

async function snapshotDependencyCacheBounded({
  dependencyCacheRoot,
  candidateRoot,
  evidenceRoot,
  destination,
  runAux,
  environment,
}) {
  const entrypoint = fileURLToPath(import.meta.url);
  let result;
  try {
    result = await runAux(
      process.execPath,
      [
        entrypoint,
        "--internal-dependency-cache-snapshot",
        dependencyCacheRoot,
        candidateRoot,
        evidenceRoot,
        destination,
      ],
      { cwd: repositoryRoot, env: environment },
    );
  } catch (error) {
    await rm(join(destination, "_cacache"), { recursive: true, force: true });
    throw error;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(result.stdout);
  } catch {
    fail(
      "pilot-dependency-cache-snapshot",
      "Private dependency-cache snapshot returned invalid bounded evidence.",
    );
  }
  if (snapshot.failure) {
    await rm(join(destination, "_cacache"), { recursive: true, force: true });
    const known = new Set([
      "pilot-dependency-cache",
      "pilot-unsafe-directory",
      "pilot-dependency-cache-type",
      "pilot-dependency-cache-index",
      "pilot-dependency-cache-credentials",
      "pilot-dependency-cache-overlap",
      "pilot-dependency-cache-changed",
    ]);
    if (known.has(snapshot.failure))
      fail(
        snapshot.failure,
        "Selected dependency cache could not be safely snapshotted; choose a canonical credential-free npm cache with complete local dependencies.",
      );
    fail(
      "pilot-dependency-cache-snapshot",
      "Selected dependency cache could not be safely snapshotted.",
    );
  }
  if (
    typeof snapshot.snapshotSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(snapshot.snapshotSha256)
  ) {
    await rm(join(destination, "_cacache"), { recursive: true, force: true });
    fail(
      "pilot-dependency-cache-snapshot",
      "Private dependency-cache snapshot returned invalid bounded evidence.",
    );
  }
  return snapshot;
}

function assertInside(root, path) {
  const within = relative(root, path);
  if (within === "" || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    fail("pilot-path-escape", "Evidence path must be beneath the selected workspace root.");
  }
}

async function prepareEvidenceRoot({ workspaceRoot, candidateLeaf, runLeaf }, runAux) {
  const canonicalRoot = await assertCanonicalDirectory(workspaceRoot, "Workspace root");
  const evidence = resolve(canonicalRoot, ".docsfab", "pilots", "tensorrt", candidateLeaf, runLeaf);
  assertInside(canonicalRoot, evidence);
  let ignored;
  try {
    const outcome = await runAux("git", ["check-ignore", "-q", "--no-index", evidence], {
      cwd: canonicalRoot,
      allowExitCode: 1,
      env: pilotChildEnvironment(process.env, {
        home: canonicalRoot,
        stateHome: canonicalRoot,
        cache: canonicalRoot,
        npmUserConfig: join(canonicalRoot, ".docsfab", "absent.npmrc"),
        npmGlobalConfig: join(canonicalRoot, ".docsfab", "absent-global.npmrc"),
      }),
    });
    ignored = outcome.exitCode !== 1;
  } catch (error) {
    if (error?.code !== 1) throw error;
    ignored = false;
  }
  if (!ignored)
    fail(
      "pilot-evidence-not-ignored",
      "Selected .docsfab/pilots/tensorrt evidence path is not Git-ignored.",
    );
  let current = canonicalRoot;
  for (const segment of [".docsfab", "pilots", "tensorrt", candidateLeaf, runLeaf]) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (segment === runLeaf && current === evidence)
        fail("pilot-evidence-exists", "Selected evidence run already exists.");
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (await realpath(current)) !== current
      ) {
        fail(
          "pilot-evidence-symlink",
          "Evidence ancestor must be a canonical nonsymlink directory.",
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      await assertCanonicalDirectory(current, "Evidence directory");
    }
  }
  for (const name of ["install", "synthetic-workspace", "state", "logs", "records", "report"]) {
    await mkdir(join(evidence, name), { mode: 0o700 });
  }
  for (const name of ["home", "tmp", "config", "cache"]) {
    await mkdir(join(evidence, "state", name), { mode: 0o700 });
  }
  await mkdir(join(evidence, "install", "pack"), { mode: 0o700 });
  await writeFile(join(evidence, "state", "empty.npmrc"), "", { flag: "wx", mode: 0o600 });
  return evidence;
}

async function treeSha256(root) {
  const digest = createHash("sha256");
  async function visit(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(directory, entry.name);
      const name = join(prefix, entry.name);
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.isFile()) {
        digest.update(name);
        digest.update(await readFile(path));
      } else fail("pilot-fixture-type", "Synthetic fixture contains a nonregular entry.");
    }
  }
  await visit(root);
  return digest.digest("hex");
}

async function prepareSyntheticWorkspace(outputRoot, runAux, environment) {
  const before = await treeSha256(fixtureRoot);
  const syntheticWorkspace = join(outputRoot, "synthetic-workspace");
  await cp(fixtureRoot, syntheticWorkspace, { recursive: true, force: false });
  await runAux("git", ["init", "-q"], { cwd: syntheticWorkspace, env: environment });
  await runAux("git", ["add", "-A"], { cwd: syntheticWorkspace, env: environment });
  await runAux(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=DocsFab Synthetic",
      "-c",
      "user.email=synthetic@example.test",
      "commit",
      "-q",
      "-m",
      "Invented fixture baseline",
    ],
    { cwd: syntheticWorkspace, env: environment },
  );
  const configuration = join(syntheticWorkspace, "docsfab.yml");
  await writeFile(
    configuration,
    `${await readFile(configuration, "utf8")}# working-only configuration\n`,
  );
  if ((await treeSha256(fixtureRoot)) !== before)
    fail("pilot-fixture-mutated", "Committed synthetic source fixture changed during preparation.");
  return { syntheticWorkspace, sourceSha256: before };
}

async function candidateSourceSnapshot(candidateRoot, artifactDirectoryLeaf, runAux, environment) {
  const trackedArtifact = await runAux("git", ["ls-files", "--", artifactDirectoryLeaf], {
    cwd: candidateRoot,
    env: environment,
  });
  if (trackedArtifact.stdout !== "") {
    fail(
      "pilot-artifact-tracked",
      "The selected retained-artifact leaf overlaps tracked source files.",
    );
  }
  const commands = [
    ["rev-parse", "HEAD"],
    ["rev-parse", "HEAD^{tree}"],
    [
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      `:(exclude)${artifactDirectoryLeaf}`,
    ],
  ];
  const [head, tree, status] = await Promise.all(
    commands.map(
      async (args) => (await runAux("git", args, { cwd: candidateRoot, env: environment })).stdout,
    ),
  );
  return {
    head: head.trim(),
    tree: tree.trim(),
    statusSha256: createHash("sha256").update(status).digest("hex"),
    clean: status.length === 0,
    excludedArtifactLeaf: artifactDirectoryLeaf,
  };
}

function pendingStages() {
  return {
    A: {
      status: "pending",
      prerequisite: "selected retained candidate and isolated offline installation",
      checks: [],
    },
    B: {
      status: "pending",
      prerequisite: "T1–T3 and T6 installed support plus sanitized saved diagnosis record",
      checks: [],
    },
    C: {
      status: "not-run",
      prerequisite: "authorized model environment and original RST corpus",
      checks: [],
    },
    D: { status: "not-run", prerequisite: "T4 candidate and identified compositions", checks: [] },
    E: {
      status: "not-run",
      prerequisite: "T7/T8 installed support and retained issue evidence",
      checks: [],
    },
    F: { status: "not-run", prerequisite: "documentation owner human assessment", checks: [] },
  };
}

function check(report, name, status, reason) {
  report.stages.A.checks.push({ name, status, ...(reason ? { reason } : {}) });
}

async function regularFileSha256(path, allowedRoot) {
  const metadata = await lstat(path);
  const canonical = await realpath(path);
  assertInside(allowedRoot, canonical);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    canonical !== path
  ) {
    fail(
      "pilot-executable-type",
      "Installed executable must be a single-link canonical regular file in the private prefix.",
    );
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function executableSha256(path, installRoot, installedPackageRoot) {
  const link = await lstat(path);
  const canonical = await realpath(path);
  assertInside(installRoot, canonical);
  assertInside(installedPackageRoot, canonical);
  const target = await lstat(canonical);
  if ((!link.isFile() && !link.isSymbolicLink()) || !target.isFile() || target.nlink !== 1) {
    fail(
      "pilot-executable-type",
      "Installed executable must resolve to a single-link regular file inside its private package.",
    );
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(canonical)) digest.update(chunk);
  return { sha256: digest.digest("hex"), resolvedRelativePath: relative(installRoot, canonical) };
}

/**
 * Run Stage A against the exact retained candidate. Injected boundaries are
 * test-only; they mark the report as mocked even when all Stage A checks pass.
 */
export async function runPilotPreparation(options, dependencies = {}) {
  const {
    workspaceRoot = repositoryRoot,
    candidateRoot,
    dependencyCacheRoot,
    artifactDirectoryLeaf,
    candidateLeaf,
    runLeaf,
  } = options;
  safeLeaf(artifactDirectoryLeaf, "--artifact-dir");
  safeLeaf(candidateLeaf, "--candidate");
  safeLeaf(runLeaf, "--run");
  if (!isAbsolute(candidateRoot)) fail("pilot-candidate-root", "Candidate root must be absolute.");
  await assertCanonicalDirectory(candidateRoot, "Candidate root");
  const runAux = dependencies.runAux ?? boundedChild;
  const runChild = dependencies.runChild ?? boundedChild;
  const outputRoot = await prepareEvidenceRoot({ workspaceRoot, candidateLeaf, runLeaf }, runAux);
  const stateHome = join(outputRoot, "state");
  const environment = pilotChildEnvironment(process.env, {
    home: join(stateHome, "home"),
    stateHome,
    cache: join(stateHome, "cache"),
    npmUserConfig: join(stateHome, "empty.npmrc"),
    npmGlobalConfig: join(stateHome, "empty-global.npmrc"),
  });
  const runPackedCommand = (command, args, options) =>
    runAux(command, args, { ...options, env: environment });
  const report = {
    kind: "tensorrt-installed-pilot-preparation",
    evidenceKind:
      Object.keys(dependencies).length > 0
        ? "synthetic-fixture-and-mocked-boundaries"
        : "synthetic-fixture-and-installed-cli",
    candidate: null,
    candidateSource: null,
    targetReference: TARGET_REFERENCE,
    syntheticFixture: null,
    platform: { platform: process.platform, arch: process.arch, node: process.version },
    stages: pendingStages(),
  };
  const recordPath = join(outputRoot, "report", "acceptance.json");
  try {
    const cacheSnapshot = await (dependencies.snapshotDependencyCache
      ? dependencies.snapshotDependencyCache({
          dependencyCacheRoot,
          candidateRoot,
          evidenceRoot: outputRoot,
          destination: join(stateHome, "cache"),
        })
      : snapshotDependencyCacheBounded({
          dependencyCacheRoot,
          candidateRoot,
          evidenceRoot: outputRoot,
          destination: join(stateHome, "cache"),
          runAux: runPackedCommand,
          environment,
        }));
    report.dependencyCache = {
      origin: "explicit-operator-selected-local-cache",
      snapshotSha256: cacheSnapshot.snapshotSha256,
    };
    check(report, "dependency-cache-snapshot", "passed");
    const sourceBefore = await candidateSourceSnapshot(
      candidateRoot,
      artifactDirectoryLeaf,
      runAux,
      environment,
    );
    if (!sourceBefore.clean)
      fail(
        "pilot-source-not-clean",
        "Selected candidate source checkout has uncommitted or untracked changes; use the exact clean source revision named by the retained artifact.",
      );
    const synthetic = await prepareSyntheticWorkspace(outputRoot, runAux, environment);
    report.syntheticFixture = {
      kind: "invented-synthetic-fixture",
      sourceSha256: synthetic.sourceSha256,
      workingConfig: "docsfab.yml",
      committedConfig: "docsfab.yml",
    };
    const packDestination = join(outputRoot, "install", "pack");
    const candidate = await (dependencies.prepareCandidate ?? preparePackedCandidate)({
      projectRoot: candidateRoot,
      packDestination,
      artifactDirectoryLeaf,
      env: environment,
      runCommand: runPackedCommand,
    });
    if (candidate.origin !== "retained-artifact")
      fail("pilot-fresh-pack", "The selected candidate was not a verified retained artifact.");
    const { record, sourceRevision, integrity, tarball } = candidate;
    if (
      record?.name !== "docsfab" ||
      typeof record.version !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceRevision)
    ) {
      fail("pilot-candidate-identity", "Retained artifact identity is incomplete or mismatched.");
    }
    if (sourceRevision !== sourceBefore.head) {
      fail(
        "pilot-candidate-source-mismatch",
        "Retained artifact source revision differs from the selected clean checkout.",
      );
    }
    const archiveSha256 = await regularFileSha256(tarball, packDestination);
    report.candidate = {
      origin: candidate.origin,
      name: record.name,
      version: record.version,
      sourceRevision,
      integrity,
      archiveSha256,
    };
    check(report, "retained-candidate", "passed");
    const installRoot = join(outputRoot, "install");
    const installed = await (dependencies.installCandidate ?? installPilotCandidate)({
      tarball,
      installRoot,
      cwd: synthetic.syntheticWorkspace,
      env: environment,
      offline: true,
      runCommand: runPackedCommand,
    });
    const installedPackageRoot = await assertCanonicalDirectory(
      installed.installedPackageRoot,
      "Installed package root",
    );
    assertInside(installRoot, installedPackageRoot);
    const installedManifest = await readInstalledManifest(
      join(installedPackageRoot, "package.json"),
    );
    if (
      !installedManifest ||
      typeof installedManifest !== "object" ||
      Array.isArray(installedManifest) ||
      installedManifest.name !== record.name ||
      installedManifest.version !== record.version
    ) {
      fail(
        "pilot-installed-manifest",
        "Installed manifest does not match the verified retained candidate.",
      );
    }
    const executableIdentity = await executableSha256(
      installed.executable,
      installRoot,
      installedPackageRoot,
    );
    report.candidate.executableSha256 = executableIdentity.sha256;
    report.candidate.executableRelativePath = relative(outputRoot, installed.executable);
    report.candidate.executableResolvedRelativePath = executableIdentity.resolvedRelativePath;
    check(report, "isolated-install", "passed");
    const expectedVersion = await (
      dependencies.installedVersionIdentity ?? qualifiedInstalledVersionIdentity
    )(installedPackageRoot, record.version, sourceRevision);
    const version = await runChild(installed.executable, ["--version"], {
      cwd: synthetic.syntheticWorkspace,
      env: environment,
    });
    if (version.stderr !== "" || version.stdout !== expectedVersion)
      fail(
        "pilot-installed-version",
        "Installed executable version does not match verified build and release identity.",
      );
    check(report, "installed-version", "passed");
    const help = await runChild(installed.executable, ["--help"], {
      cwd: synthetic.syntheticWorkspace,
      env: environment,
    });
    if (help.stderr !== "" || help.stdout.trim() === "")
      fail("pilot-installed-help", "Installed help command did not return usable offline output.");
    check(report, "installed-help", "passed");
    const selfTest = await runChild(installed.executable, ["test", "--json"], {
      cwd: synthetic.syntheticWorkspace,
      env: environment,
    });
    let selfTestRecord;
    try {
      selfTestRecord = JSON.parse(selfTest.stdout);
    } catch {
      fail("pilot-self-test-record", "Installed offline self-test did not return valid JSON.");
    }
    if (
      selfTest.stderr !== "" ||
      selfTestRecord?.kind !== "docsfab-offline-product-test" ||
      selfTestRecord.status !== "passed"
    ) {
      fail(
        "pilot-self-test-failed",
        "Installed offline self-test did not report a passed product test.",
      );
    }
    check(report, "offline-self-test", "passed");
    const sourceAfter = await candidateSourceSnapshot(
      candidateRoot,
      artifactDirectoryLeaf,
      runAux,
      environment,
    );
    if (!sourceAfter.clean || JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
      fail("pilot-source-changed", "Candidate source checkout changed during installed Stage A.");
    }
    report.candidateSource = { ...sourceBefore, unchanged: true };
    check(report, "candidate-source-unchanged", "passed");
    report.stages.A.status = "passed";
    if (dependencies.offlineChecks) {
      const checks = await dependencies.offlineChecks({
        executable: installed.executable,
        syntheticWorkspace: synthetic.syntheticWorkspace,
        environment,
      });
      if (
        !Array.isArray(checks) ||
        checks.some(
          (entry) =>
            typeof entry?.name !== "string" ||
            !/^[a-z0-9][a-z0-9-]*$/u.test(entry.name) ||
            !["passed", "failed", "pending", "not-run"].includes(entry.status),
        )
      ) {
        fail("pilot-offline-checks", "Injected offline checks returned an invalid result list.");
      }
      report.stages.B.checks = checks.map(({ name, status, evidenceKind }) => ({
        name,
        status,
        ...(evidenceKind === "invented-synthetic-fixture" ? { evidenceKind } : {}),
      }));
      // Partial synthetic checks never establish the original repository,
      // saved-run, doctor, and approved-init Stage B acceptance as a whole.
      report.stages.B.status = "pending";
    }
  } catch (error) {
    const code = error instanceof PilotFailure ? error.code : "pilot-required-check-failed";
    const details = error instanceof PilotFailure ? error.details : undefined;
    if (report.stages.A.status !== "passed") {
      report.stages.A.status = "failed";
      const names = [
        "dependency-cache-snapshot",
        "retained-candidate",
        "isolated-install",
        "installed-version",
        "installed-help",
        "offline-self-test",
        "candidate-source-unchanged",
      ];
      const next = names[report.stages.A.checks.length] ?? "stage-a-check";
      check(report, next, "failed", code);
    } else {
      report.stages.B.checks.push({ name: "offline-preparation", status: "failed", reason: code });
      report.stages.B.status = "pending";
    }
    report.failure = { code, ...(details ? { details } : {}) };
  }
  await writeFile(recordPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return report;
}

async function main() {
  const parsed = parsePilotArguments(process.argv.slice(2));
  const report = await runPilotPreparation(parsed);
  if (report.stages.A.status !== "passed") {
    const bound = report.failure?.details;
    const observation = bound?.limit
      ? ` ${bound.limit}: observed ${bound.observed}, bound ${bound.bound}, scope ${bound.scope}. ${bound.remediation}`
      : "";
    console.error(
      `TensorRT installed pilot preparation failed Stage A (${report.failure?.code ?? "unknown"}).${observation} B–F remain pending or not run.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "TensorRT installed pilot Stage A passed; B–F remain pending or not run. This is preparation, not qualification.",
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const internalSnapshot = process.argv[2] === "--internal-dependency-cache-snapshot";
  const operation = internalSnapshot
    ? snapshotDependencyCache({
        dependencyCacheRoot: process.argv[3],
        candidateRoot: process.argv[4],
        evidenceRoot: process.argv[5],
        destination: process.argv[6],
      }).then((snapshot) => process.stdout.write(`${JSON.stringify(snapshot)}\n`))
    : main();
  operation.catch((error) => {
    if (internalSnapshot) {
      process.stdout.write(
        `${JSON.stringify({ failure: error instanceof PilotFailure ? error.code : "pilot-dependency-cache-snapshot" })}\n`,
      );
      return;
    }
    console.error(
      error instanceof PilotFailure
        ? error.message
        : "TensorRT pilot preparation failed before a report could be saved.",
    );
    process.exitCode = 1;
  });
}
