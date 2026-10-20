// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, test } from "vitest";

import {
  executeBoundedPilotChild,
  installPilotCandidate,
  parsePilotArguments,
  pilotChildEnvironment,
  runPilotPreparation,
  snapshotDependencyCache,
} from "./tensorrt-pilot-acceptance.mjs";

const execute = promisify(execFile);
const roots = [];
const script = resolve("scripts/tensorrt-pilot-acceptance.mjs");
const sourceFixture = resolve("test/fixtures/tensorrt-pilot");

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-tensorrt-pilot-test-")));
  roots.push(root);
  const workspaceRoot = join(root, "harness");
  const candidateRoot = join(root, "candidate");
  const dependencyCacheRoot = join(root, "dependency-cache");
  await mkdir(workspaceRoot);
  await mkdir(candidateRoot);
  await mkdir(join(dependencyCacheRoot, "_cacache", "content-v2"), { recursive: true });
  await mkdir(join(dependencyCacheRoot, "_cacache", "index-v5"), { recursive: true });
  await writeFile(join(workspaceRoot, ".gitignore"), ".docsfab/\n");
  await execute("git", ["init", "-q"], { cwd: workspaceRoot });
  await writeFile(
    join(candidateRoot, "README.md"),
    "Invented retained-candidate source fixture.\n",
  );
  await execute("git", ["init", "-q"], { cwd: candidateRoot });
  await execute("git", ["add", "README.md"], { cwd: candidateRoot });
  await execute(
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
      "Invented candidate baseline",
    ],
    { cwd: candidateRoot },
  );
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: candidateRoot });
  return {
    root,
    workspaceRoot,
    candidateRoot,
    dependencyCacheRoot,
    candidateRevision: stdout.trim(),
  };
}

function options(state, run = "run-one") {
  return {
    workspaceRoot: state.workspaceRoot,
    candidateRoot: state.candidateRoot,
    dependencyCacheRoot: state.dependencyCacheRoot,
    artifactDirectoryLeaf: "retained-candidate",
    candidateLeaf: "tensorrt-candidate",
    runLeaf: run,
  };
}

function fakeBoundaries({
  failCommand,
  mismatchVersion = false,
  candidateOrigin = "retained-artifact",
  candidateSourceRevision,
  manifestBytes,
  onCommand,
} = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      runAux: (command, args, options) => execute(command, args, options),
      prepareCandidate: async ({ projectRoot, packDestination, artifactDirectoryLeaf }) => {
        assert.equal(artifactDirectoryLeaf, "retained-candidate");
        const { stdout: sourceRevision } = await execute("git", ["rev-parse", "HEAD"], {
          cwd: projectRoot,
        });
        const tarball = join(packDestination, "docsfab.tgz");
        await writeFile(tarball, "synthetic retained bytes");
        return {
          origin: candidateOrigin,
          tarball,
          integrity: "sha512-synthetic-test-only",
          sourceRevision: candidateSourceRevision ?? sourceRevision.trim(),
          record: { name: "docsfab", version: "1.2.3", size: 24 },
        };
      },
      snapshotDependencyCache: async () => ({ snapshotSha256: "a".repeat(64) }),
      installCandidate: async ({ installRoot, offline }) => {
        assert.equal(offline, true);
        const installedPackageRoot = join(installRoot, "lib", "node_modules", "docsfab");
        const executable = join(installRoot, "bin", "docsfab");
        await mkdir(join(installedPackageRoot, "bin"), { recursive: true });
        await mkdir(join(installRoot, "bin"), { recursive: true });
        const manifest = JSON.stringify({ name: "docsfab", version: "1.2.3" });
        assert.equal(
          manifestBytes === undefined || manifestBytes >= Buffer.byteLength(manifest),
          true,
        );
        await writeFile(
          join(installedPackageRoot, "package.json"),
          manifest.padEnd(manifestBytes ?? manifest.length, " "),
        );
        const executableTarget = join(installedPackageRoot, "bin", "docsfab");
        await writeFile(executableTarget, "#!/bin/sh\nexit 0\n");
        await chmod(executableTarget, 0o700);
        await symlink("../lib/node_modules/docsfab/bin/docsfab", executable);
        return { installedPackageRoot, executable };
      },
      installedVersionIdentity: async () => (mismatchVersion ? "0.0.0\n" : "1.2.3\n"),
      runChild: async (command, args, execution) => {
        calls.push({ command, args, execution });
        await onCommand?.(command, args, execution);
        if (args[0] === failCommand) throw new Error("private-child-stderr-must-not-leak");
        if (args[0] === "--version") return { stdout: "1.2.3\n", stderr: "" };
        if (args[0] === "--help") return { stdout: "DocsFab help\n", stderr: "" };
        if (args[0] === "test")
          return {
            stdout: JSON.stringify({ kind: "docsfab-offline-product-test", status: "passed" }),
            stderr: "",
          };
        throw new Error("unexpected fake command");
      },
    },
  };
}

async function fixtureDigest(root) {
  const digest = createHash("sha256");
  async function visit(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else {
        assert.equal(entry.isFile(), true);
        digest.update(relative);
        digest.update(await readFile(join(directory, entry.name)));
      }
    }
  }
  await visit(root);
  return digest.digest("hex");
}

test("entry point requires one retained candidate and safe evidence leaves", async () => {
  const state = await fixture();
  assert.throws(() => parsePilotArguments([]), /--candidate-root/);
  assert.throws(
    () =>
      parsePilotArguments([
        "--candidate-root",
        state.candidateRoot,
        "--artifact-dir",
        "retained-candidate",
        "--candidate",
        "candidate-one",
        "--run",
        "run-one",
      ]),
    /--dependency-cache/,
  );
  assert.throws(
    () =>
      parsePilotArguments([
        "--candidate-root",
        state.candidateRoot,
        "--dependency-cache",
        state.dependencyCacheRoot,
        "--candidate",
        "one",
        "--run",
        "two",
      ]),
    /--artifact-dir/,
  );
  assert.throws(
    () =>
      parsePilotArguments([
        "--candidate-root",
        state.candidateRoot,
        "--dependency-cache",
        state.dependencyCacheRoot,
        "--artifact-dir",
        "../escape",
        "--candidate",
        "one",
        "--run",
        "two",
      ]),
    /safe leaf/,
  );
  const accepted = parsePilotArguments([
    "--candidate-root",
    state.candidateRoot,
    "--dependency-cache",
    state.dependencyCacheRoot,
    "--artifact-dir",
    "retained-candidate",
    "--candidate",
    "candidate-one",
    "--run",
    "run-one",
  ]);
  assert.equal(accepted.artifactDirectoryLeaf, "retained-candidate");
  await assert.rejects(
    execute(process.execPath, [script], { cwd: state.workspaceRoot }),
    /--candidate-root/,
  );
  const symlinkedScript = join(state.root, "pilot-entrypoint-link.mjs");
  await symlink(script, symlinkedScript);
  await assert.rejects(
    execute(process.execPath, [symlinkedScript], { cwd: state.workspaceRoot }),
    /--candidate-root/,
  );
});

test("explicit warmed cache installs a synthetic external dependency offline into private state", async () => {
  const state = await fixture();
  const packageRoot = join(state.root, "dependency-package");
  const packageOutput = join(state.root, "dependency-tarball");
  const seedRoot = join(state.root, "seed-project");
  const installRoot = join(state.root, "private-install");
  const emptyConfig = join(state.root, "empty.npmrc");
  const emptyGlobalConfig = join(state.root, "empty-global.npmrc");
  const home = join(state.root, "isolated-home");
  const temp = join(state.root, "isolated-tmp");
  await mkdir(packageRoot);
  await mkdir(packageOutput);
  await mkdir(seedRoot);
  await mkdir(home, { mode: 0o700 });
  await mkdir(temp, { mode: 0o700 });
  await writeFile(emptyConfig, "", { mode: 0o600 });
  await writeFile(emptyGlobalConfig, "", { mode: 0o600 });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "cache-fixture-dependency", version: "1.0.0", main: "index.js" }),
  );
  await writeFile(join(packageRoot, "index.js"), "export const fixtureDependency = true;\n");
  const packageBytes = Buffer.from(
    await execute("npm", ["pack", "--json", "--pack-destination", packageOutput], {
      cwd: packageRoot,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: temp,
        npm_config_userconfig: emptyConfig,
        npm_config_globalconfig: emptyGlobalConfig,
      },
      timeout: 30_000,
      maxBuffer: 16_384,
    }).then(({ stdout }) => {
      const [record] = JSON.parse(stdout);
      return readFile(join(packageOutput, record.filename));
    }),
  );
  const integrity = `sha512-${createHash("sha512").update(packageBytes).digest("base64")}`;
  let requests = 0;
  let authorizationSeen = false;
  const server = createServer((request, response) => {
    requests += 1;
    authorizationSeen ||= Boolean(request.headers.authorization);
    if (request.url === "/cache-fixture-dependency") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "cache-fixture-dependency",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name: "cache-fixture-dependency",
              version: "1.0.0",
              dist: { tarball: `${registry}/cache-fixture-dependency-1.0.0.tgz`, integrity },
            },
          },
        }),
      );
    } else if (request.url === "/cache-fixture-dependency-1.0.0.tgz") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(packageBytes);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const registry = `http://127.0.0.1:${server.address().port}`;
  try {
    await writeFile(
      join(state.dependencyCacheRoot, ".npmrc"),
      "//registry.invalid/:_authToken=fixture-secret\n",
    );
    await writeFile(
      join(home, ".npmrc"),
      `//127.0.0.1:${server.address().port}/:_authToken=fixture-secret\nregistry=${registry}/\n`,
    );
    await mkdir(join(state.dependencyCacheRoot, "_logs"), { recursive: true });
    await writeFile(join(state.dependencyCacheRoot, "_logs", "npm.log"), "fixture log\n");
    await writeFile(
      join(seedRoot, "package.json"),
      JSON.stringify({ name: "cache-seed", version: "1.0.0" }),
    );
    const seedEnv = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: temp,
      LANG: "C",
      npm_config_cache: state.dependencyCacheRoot,
      npm_config_userconfig: emptyConfig,
      npm_config_globalconfig: emptyGlobalConfig,
      npm_config_registry: `${registry}/`,
      npm_config_offline: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
    };
    await execute(
      "npm",
      [
        "install",
        "--prefix",
        seedRoot,
        "--package-lock=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "cache-fixture-dependency@1.0.0",
      ],
      { cwd: seedRoot, env: seedEnv, timeout: 30_000, maxBuffer: 16_384 },
    );
    assert.ok(requests > 0, "the local-only registry warmed the selected cache");
    assert.equal(authorizationSeen, false, "the isolated seed ignored the HOME npmrc");

    await writeFile(
      join(state.candidateRoot, "package.json"),
      JSON.stringify({
        name: "docsfab",
        version: "1.2.3",
        dependencies: { "cache-fixture-dependency": "1.0.0" },
      }),
    );
    await writeFile(join(state.candidateRoot, "index.js"), "export {};\n");
    await execute("git", ["add", "package.json", "index.js"], { cwd: state.candidateRoot });
    await execute(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-q",
        "-m",
        "Synthetic package",
      ],
      { cwd: state.candidateRoot },
    );
    const sourceShaBefore = await fixtureDigest(state.candidateRoot);
    const candidateOutput = join(state.root, "candidate-tarball");
    await mkdir(candidateOutput);
    const { stdout: packedStdout } = await execute(
      "npm",
      ["pack", "--json", "--pack-destination", candidateOutput],
      { cwd: state.candidateRoot, env: seedEnv, timeout: 30_000, maxBuffer: 16_384 },
    );
    const [{ filename }] = JSON.parse(packedStdout);
    const candidateTarball = join(candidateOutput, filename);

    const privateCache = join(state.root, "private-cache");
    await mkdir(privateCache, { mode: 0o700 });
    const selectedCacheBefore = await fixtureDigest(state.dependencyCacheRoot);
    const cacheSnapshot = await snapshotDependencyCache({
      dependencyCacheRoot: state.dependencyCacheRoot,
      candidateRoot: state.candidateRoot,
      evidenceRoot: join(state.root, "evidence"),
      destination: privateCache,
    });
    assert.match(cacheSnapshot.snapshotSha256, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(cacheSnapshot).includes("fixture-secret"), false);
    assert.equal((await lstat(privateCache)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(privateCache), ["_cacache"]);
    assert.equal(
      JSON.stringify(await readdir(join(privateCache, "_cacache"))).includes(".npmrc"),
      false,
    );
    assert.equal(await fixtureDigest(state.candidateRoot), sourceShaBefore);
    assert.equal(await fixtureDigest(state.dependencyCacheRoot), selectedCacheBefore);

    const requestsBeforeOfflineInstall = requests;
    const offlineEnv = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: temp,
      LANG: "C",
      CI: "1",
      npm_config_cache: privateCache,
      npm_config_userconfig: emptyConfig,
      npm_config_globalconfig: emptyGlobalConfig,
      npm_config_registry: `${registry}/`,
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
    };
    const installed = await installPilotCandidate({
      tarball: candidateTarball,
      installRoot,
      cwd: state.root,
      env: offlineEnv,
      runCommand: (command, args, execution) =>
        executeBoundedPilotChild(command, args, execution, {
          timeout: {
            value: 30_000,
            name: "tensorrtPilot.commandTimeoutMs",
            refusal: "tensorrt-pilot-command-timeout-ms-bound",
            remediation: "Retry the bounded test.",
          },
          output: {
            value: 16_384,
            name: "tensorrtPilot.commandOutputBytes",
            refusal: "tensorrt-pilot-command-output-bytes-bound",
            remediation: "Retry the bounded test.",
          },
        }),
    });
    assert.equal(requests, requestsBeforeOfflineInstall, "offline install made no network request");
    assert.equal(authorizationSeen, false, "offline install did not inherit the HOME npmrc");
    assert.equal(
      JSON.parse(
        await readFile(
          join(
            installed.installedPackageRoot,
            "node_modules",
            "cache-fixture-dependency",
            "package.json",
          ),
          "utf8",
        ),
      ).version,
      "1.0.0",
    );
    assert.equal(await fixtureDigest(state.candidateRoot), sourceShaBefore);
    assert.equal(
      (await readFile(join(state.dependencyCacheRoot, ".npmrc"), "utf8")).includes(
        "fixture-secret",
      ),
      true,
    );
    assert.equal((await readdir(privateCache)).includes(".npmrc"), false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}, 30_000);

test("dependency-cache snapshot refuses overlap, symlinks, and credential-bearing index data", async () => {
  const state = await fixture();
  const destination = join(state.root, "private-cache");
  await mkdir(destination, { mode: 0o700 });
  const base = {
    dependencyCacheRoot: state.dependencyCacheRoot,
    candidateRoot: state.candidateRoot,
    evidenceRoot: join(state.root, "evidence"),
    destination,
  };
  await assert.rejects(
    snapshotDependencyCache({ ...base, dependencyCacheRoot: state.candidateRoot }),
    (error) => error.code === "pilot-dependency-cache-overlap",
  );
  await assert.rejects(
    snapshotDependencyCache({ ...base, destination: state.dependencyCacheRoot }),
    (error) => error.code === "pilot-dependency-cache-overlap",
  );
  const indexRoot = join(state.dependencyCacheRoot, "_cacache", "index-v5");
  await writeFile(
    join(indexRoot, "credential-record"),
    '{"metadata":{"authorization":"hidden"}}\n',
  );
  await assert.rejects(
    snapshotDependencyCache(base),
    (error) => error.code === "pilot-dependency-cache-credentials",
  );
  await rm(join(indexRoot, "credential-record"));
  const externalFile = join(state.root, "external-cache-file");
  await writeFile(externalFile, "not part of a regular cache tree");
  await symlink(externalFile, join(indexRoot, "linked-record"));
  await assert.rejects(
    snapshotDependencyCache(base),
    (error) => error.code === "pilot-dependency-cache-type",
  );
});

test("dependency-cache index screening decodes escaped keys and streams long URL authorities", async () => {
  const state = await fixture();
  const destination = join(state.root, "private-cache");
  await mkdir(destination, { mode: 0o700 });
  const base = {
    dependencyCacheRoot: state.dependencyCacheRoot,
    candidateRoot: state.candidateRoot,
    evidenceRoot: join(state.root, "evidence"),
    destination,
  };
  const indexRecord = join(state.dependencyCacheRoot, "_cacache", "index-v5", "screening");

  await writeFile(indexRecord, '{"metadata":{"\\u0074oken":"hidden"}}\n');
  await assert.rejects(
    snapshotDependencyCache(base),
    (error) => error.code === "pilot-dependency-cache-credentials",
  );

  await writeFile(indexRecord, '{"metadata":{"label":"bad\\u12"}}\n');
  await assert.rejects(
    snapshotDependencyCache(base),
    (error) => error.code === "pilot-dependency-cache-index",
  );

  const longUsername = "u".repeat(70_000);
  await writeFile(
    indexRecord,
    `{"metadata":{"url":"https://${longUsername}:pw@cache.example/pkg"}}\n`,
  );
  await assert.rejects(
    snapshotDependencyCache(base),
    (error) => error.code === "pilot-dependency-cache-credentials",
  );

  const longPath = "p".repeat(70_000);
  for (const query of ["token=secret", String.raw`to\u006ben=secret`, "%74oken=secret"]) {
    await writeFile(
      indexRecord,
      `{"metadata":{"url":"https://cache.example/${longPath}?${query}"}}\n`,
    );
    await assert.rejects(
      snapshotDependencyCache(base),
      (error) => error.code === "pilot-dependency-cache-credentials",
    );
  }

  const safeDestination = join(state.root, "safe-private-cache");
  await mkdir(safeDestination, { mode: 0o700 });
  await writeFile(
    indexRecord,
    `{"metadata":{"url":"https://cache.example/${longPath}?page=2&view=compact"}}\n`,
  );
  await snapshotDependencyCache({ ...base, destination: safeDestination });
});

test("the production snapshot child records only a digest in the Stage A report", async () => {
  const state = await fixture();
  const fake = fakeBoundaries();
  const { snapshotDependencyCache: _injectedSnapshot, ...dependencies } = fake.dependencies;
  const report = await runPilotPreparation(options(state), dependencies);
  assert.equal(report.stages.A.status, "passed");
  assert.match(report.dependencyCache.snapshotSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(report).includes(state.dependencyCacheRoot), false);
  const outputCache = join(
    state.workspaceRoot,
    ".docsfab",
    "pilots",
    "tensorrt",
    "tensorrt-candidate",
    "run-one",
    "state",
    "cache",
  );
  assert.equal((await lstat(outputCache)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(outputCache)).sort(), ["_cacache"]);
  assert.deepEqual((await readdir(join(outputCache, "_cacache"))).sort(), [
    "content-v2",
    "index-v5",
  ]);
});

test("mocked installed Stage A records exact identity, checks and truthful pending stages", async () => {
  const state = await fixture();
  const fake = fakeBoundaries();
  const fixtureShaBefore = await fixtureDigest(sourceFixture);
  const report = await runPilotPreparation(options(state), fake.dependencies);
  assert.equal(report.kind, "tensorrt-installed-pilot-preparation");
  assert.equal(report.evidenceKind, "synthetic-fixture-and-mocked-boundaries");
  assert.equal(report.candidate.origin, "retained-artifact");
  assert.equal(report.candidate.sourceRevision, state.candidateRevision);
  assert.equal(report.candidate.version, "1.2.3");
  assert.equal(report.stages.A.status, "passed");
  assert.deepEqual(
    report.stages.A.checks.map((check) => check.name),
    [
      "dependency-cache-snapshot",
      "retained-candidate",
      "isolated-install",
      "installed-version",
      "installed-help",
      "offline-self-test",
      "candidate-source-unchanged",
    ],
  );
  assert.equal(report.candidateSource.head, state.candidateRevision);
  assert.equal(report.candidateSource.unchanged, true);
  for (const stage of ["B", "C", "D", "E", "F"])
    assert.notEqual(report.stages[stage].status, "passed");
  assert.deepEqual(
    fake.calls.map((call) => call.args),
    [["--version"], ["--help"], ["test", "--json"]],
  );
  const outputRoot = join(
    state.workspaceRoot,
    ".docsfab",
    "pilots",
    "tensorrt",
    "tensorrt-candidate",
    "run-one",
  );
  const persisted = JSON.parse(
    await readFile(join(outputRoot, "report", "acceptance.json"), "utf8"),
  );
  assert.deepEqual(persisted, report);
  assert.equal((await lstat(join(outputRoot, "install"))).isDirectory(), true);
  assert.equal((await lstat(join(outputRoot, "synthetic-workspace"))).isDirectory(), true);
  assert.equal((await lstat(join(outputRoot, "state"))).isDirectory(), true);
  assert.equal((await lstat(join(outputRoot, "logs"))).isDirectory(), true);
  assert.equal((await lstat(join(outputRoot, "records"))).isDirectory(), true);
  const executable = join(outputRoot, "install", "bin", "docsfab");
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  assert.equal(report.candidate.executableSha256, digest);
  assert.equal(report.candidate.executableRelativePath, "install/bin/docsfab");
  assert.equal(await fixtureDigest(sourceFixture), fixtureShaBefore);
  assert.equal(report.syntheticFixture.kind, "invented-synthetic-fixture");
  assert.equal(report.syntheticFixture.sourceSha256, fixtureShaBefore);
  const synthetic = join(outputRoot, "synthetic-workspace");
  assert.match(
    await readFile(join(synthetic, "documentation", "tensorrt", "11.4.0", "index.rst"), "utf8"),
    /toctree/,
  );
  assert.match(
    await readFile(
      join(synthetic, "documentation", "tensorrt", "11.4.0", "c-api", "functions_~.html"),
      "utf8",
    ),
    /Invented/,
  );
  assert.match(
    await readFile(
      join(synthetic, "documentation", "tensorrt", "11.4.0", "c-api", "functions_func_~.html"),
      "utf8",
    ),
    /Invented/,
  );
  assert.match(
    await readFile(join(synthetic, ".docsfab", "mr-descriptions", "!75.md"), "utf8"),
    /Synthetic/,
  );
  assert.match(await readFile(join(synthetic, "docs", "unrelated.md"), "utf8"), /Unrelated/);
  const { stdout: gitStatus } = await execute("git", ["status", "--short"], { cwd: synthetic });
  assert.equal(gitStatus, " M docsfab.yml\n");
  assert.equal(report.targetReference.revision, "ad0af131a100d09cbfc15cf1f80644af7d8e2789");
  assert.deepEqual(report.targetReference.syntheticPathShapes, [
    "documentation/tensorrt/11.4.0/c-api/functions_~.html",
    "documentation/tensorrt/11.4.0/c-api/functions_func_~.html",
    ".docsfab/mr-descriptions/!75.md",
  ]);
});

test("a failed installed child leaves Stage A failed and no later pass, without private stderr", async () => {
  const state = await fixture();
  const fake = fakeBoundaries({ failCommand: "--help" });
  const report = await runPilotPreparation(options(state), fake.dependencies);
  assert.equal(report.stages.A.status, "failed");
  assert.equal(report.stages.A.checks.at(-1).name, "installed-help");
  assert.equal(report.stages.A.checks.at(-1).status, "failed");
  assert.equal(JSON.stringify(report).includes("private-child-stderr-must-not-leak"), false);
  for (const stage of ["B", "C", "D", "E", "F"])
    assert.notEqual(report.stages[stage].status, "passed");
});

test("installed version mismatch refuses Stage A even with a successful child exit", async () => {
  const state = await fixture();
  const fake = fakeBoundaries({ mismatchVersion: true });
  const report = await runPilotPreparation(options(state), fake.dependencies);
  assert.equal(report.stages.A.status, "failed");
  assert.equal(report.stages.A.checks.at(-1).name, "installed-version");
  assert.deepEqual(
    fake.calls.map((call) => call.args),
    [["--version"]],
  );
});

test("installed manifest accepts its canonical byte bound and refuses bound plus one", async () => {
  const accepted = await fixture();
  const acceptedFake = fakeBoundaries({ manifestBytes: 65_536 });
  const acceptedReport = await runPilotPreparation(options(accepted), acceptedFake.dependencies);
  assert.equal(acceptedReport.stages.A.status, "passed");

  const refused = await fixture();
  const refusedFake = fakeBoundaries({ manifestBytes: 65_537 });
  const refusedReport = await runPilotPreparation(options(refused), refusedFake.dependencies);
  assert.equal(refusedReport.stages.A.status, "failed");
  assert.equal(refusedReport.stages.A.checks.at(-1).name, "isolated-install");
  assert.equal(refusedReport.failure.code, "tensorrt-pilot-installed-manifest-bytes-bound");
  assert.equal(refusedReport.failure.details.observed, 65_537);
  assert.equal(refusedReport.failure.details.bound, 65_536);
  assert.equal(refusedFake.calls.length, 0);
});

test("an installed child that changes the candidate source cannot pass Stage A", async () => {
  const state = await fixture();
  const fake = fakeBoundaries({
    onCommand: (_command, args) => {
      if (args[0] === "test")
        return writeFile(join(state.candidateRoot, "README.md"), "Changed by a fake child.\n");
    },
  });
  const report = await runPilotPreparation(options(state), fake.dependencies);
  assert.equal(report.stages.A.status, "failed");
  assert.equal(report.stages.A.checks.at(-1).name, "candidate-source-unchanged");
  assert.equal(report.failure.code, "pilot-source-changed");
});

test("a pre-existing candidate source edit cannot be hidden by an unchanged status line", async () => {
  const state = await fixture();
  await writeFile(
    join(state.candidateRoot, "README.md"),
    "Pre-existing uncommitted source edit.\n",
  );
  const fake = fakeBoundaries();
  const report = await runPilotPreparation(options(state), fake.dependencies);
  assert.equal(report.stages.A.status, "failed");
  assert.equal(report.failure.code, "pilot-source-not-clean");
  assert.equal(fake.calls.length, 0);
});

test("the explicit untracked retained-artifact leaf is allowed while source remains clean", async () => {
  const state = await fixture();
  const artifact = join(state.candidateRoot, "retained-candidate");
  await mkdir(artifact);
  await writeFile(join(artifact, "docsfab.tgz"), "invented retained bytes");
  const fake = fakeBoundaries();
  const report = await runPilotPreparation(options(state), fake.dependencies);
  assert.equal(report.stages.A.status, "passed");
  assert.equal(report.candidateSource.clean, true);
  assert.equal(report.candidateSource.excludedArtifactLeaf, "retained-candidate");
});

test("the retained-artifact exclusion cannot hide tracked source files", async () => {
  const state = await fixture();
  const artifact = join(state.candidateRoot, "retained-candidate");
  await mkdir(artifact);
  await writeFile(join(artifact, "tracked.txt"), "This file is source, not a retained artifact.\n");
  await execute("git", ["add", "retained-candidate/tracked.txt"], { cwd: state.candidateRoot });
  await execute(
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
      "Track candidate leaf",
    ],
    { cwd: state.candidateRoot },
  );
  const fake = fakeBoundaries();
  const report = await runPilotPreparation(options(state), fake.dependencies);
  assert.equal(report.stages.A.status, "failed");
  assert.equal(report.failure.code, "pilot-artifact-tracked");
  assert.equal(fake.calls.length, 0);
});

test("a helper fresh-pack fallback cannot be accepted as the selected retained candidate", async () => {
  const state = await fixture();
  const fake = fakeBoundaries({ candidateOrigin: "fresh-pack" });
  const report = await runPilotPreparation(options(state), fake.dependencies);
  assert.equal(report.stages.A.status, "failed");
  assert.equal(report.stages.A.checks.at(-1).name, "retained-candidate");
  assert.equal(fake.calls.length, 0);
});

test("a retained artifact from another source revision cannot pass installed Stage A", async () => {
  const state = await fixture();
  const fake = fakeBoundaries({ candidateSourceRevision: "a".repeat(40) });
  const report = await runPilotPreparation(options(state), fake.dependencies);
  assert.equal(report.stages.A.status, "failed");
  assert.equal(report.failure.code, "pilot-candidate-source-mismatch");
  assert.equal(fake.calls.length, 0);
});

test("missing retained bytes fail Stage A without leaking verifier diagnostics", async () => {
  const state = await fixture();
  const fake = fakeBoundaries();
  const report = await runPilotPreparation(options(state), {
    ...fake.dependencies,
    prepareCandidate: async () => {
      throw new Error("private-verifier-detail-must-not-leak");
    },
  });
  assert.equal(report.stages.A.status, "failed");
  assert.equal(report.stages.A.checks.at(-1).name, "retained-candidate");
  assert.equal(JSON.stringify(report).includes("private-verifier-detail-must-not-leak"), false);
  assert.equal(fake.calls.length, 0);
});

test("offline B adapters record individual synthetic checks without claiming complete Stage B", async () => {
  const state = await fixture();
  const fake = fakeBoundaries();
  const report = await runPilotPreparation(options(state), {
    ...fake.dependencies,
    offlineChecks: async ({ syntheticWorkspace }) => {
      assert.match(
        await readFile(
          join(syntheticWorkspace, "documentation", "tensorrt", "11.4.0", "index.rst"),
          "utf8",
        ),
        /toctree/,
      );
      return [
        {
          name: "synthetic-path-shapes",
          status: "passed",
          evidenceKind: "invented-synthetic-fixture",
        },
      ];
    },
  });
  assert.equal(report.stages.B.status, "pending");
  assert.deepEqual(report.stages.B.checks, [
    { name: "synthetic-path-shapes", status: "passed", evidenceKind: "invented-synthetic-fixture" },
  ]);
  assert.equal(report.stages.C.status, "not-run");
});

test("existing or symlink evidence targets refuse before child execution", async () => {
  const state = await fixture();
  const fake = fakeBoundaries();
  const first = options(state);
  await runPilotPreparation(first, fake.dependencies);
  await assert.rejects(runPilotPreparation(first, fake.dependencies), /already exists/);
  const candidateDir = join(
    state.workspaceRoot,
    ".docsfab",
    "pilots",
    "tensorrt",
    "tensorrt-candidate",
  );
  await symlink(state.root, join(candidateDir, "run-link"));
  await assert.rejects(
    runPilotPreparation(options(state, "run-link"), fake.dependencies),
    /already exists|symlink/,
  );
  assert.equal(fake.calls.length, 3);
});

test("a symlink candidate root is rejected before creating evidence", async () => {
  const state = await fixture();
  const candidateLink = join(state.root, "candidate-link");
  await symlink(state.candidateRoot, candidateLink);
  const fake = fakeBoundaries();
  await assert.rejects(
    runPilotPreparation({ ...options(state), candidateRoot: candidateLink }, fake.dependencies),
    /canonical nonsymlink/,
  );
  assert.equal(fake.calls.length, 0);
});

test("installed children receive only isolated, credential-free environment", async () => {
  const state = await fixture();
  const secret = "DO-NOT-RETAIN-THIS-TOKEN";
  const childEnv = pilotChildEnvironment(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      NPM_TOKEN: secret,
      MODEL_API_KEY: secret,
      AWS_SECRET_ACCESS_KEY: secret,
      NODE_OPTIONS: "--require /private/module.js",
      npm_config_userconfig: "/private/npmrc",
    },
    {
      home: join(state.root, "home"),
      stateHome: join(state.root, "state"),
      cache: join(state.root, "cache"),
      npmUserConfig: join(state.root, "empty.npmrc"),
      npmGlobalConfig: join(state.root, "empty-global.npmrc"),
    },
  );
  assert.equal(childEnv.NPM_TOKEN, undefined);
  assert.equal(childEnv.MODEL_API_KEY, undefined);
  assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.PI_OFFLINE, "1");
  assert.equal(childEnv.npm_config_offline, "true");
  assert.equal(childEnv.HOME, join(state.root, "home"));
  assert.equal(JSON.stringify(childEnv).includes(secret), false);
});

test("packed preparation and install share the bounded, isolated pilot runner", async () => {
  const state = await fixture();
  const fake = fakeBoundaries();
  const output = {
    name: "tensorrtPilot.commandOutputBytes",
    value: 64,
    unit: "bytes",
    refusal: "tensorrt-pilot-command-output-bytes-bound",
    remediation: "Measure and review the supported output.",
  };
  const timeout = {
    name: "tensorrtPilot.commandTimeoutMs",
    value: 5_000,
    unit: "milliseconds",
    refusal: "tensorrt-pilot-command-timeout-ms-bound",
    remediation: "Measure and review the supported duration.",
  };
  let prepareRunner;
  const report = await runPilotPreparation(options(state), {
    ...fake.dependencies,
    runAux: (command, args, execution) =>
      command === process.execPath
        ? executeBoundedPilotChild(command, args, execution, { timeout, output })
        : fake.dependencies.runAux(command, args, execution),
    prepareCandidate: async (input) => {
      prepareRunner = input.runCommand;
      await assert.rejects(
        prepareRunner(process.execPath, ["-e", "process.stdout.write('x'.repeat(65))"], {}),
        (error) => error.code === output.refusal && error.details.limit === output.name,
      );
      return fake.dependencies.prepareCandidate(input);
    },
    installCandidate: async (input) => {
      assert.equal(input.runCommand, prepareRunner);
      const result = await input.runCommand(
        process.execPath,
        ["-e", "process.stdout.write(process.env.NPM_TOKEN ? 'BAD' : 'SAFE')"],
        { env: { NPM_TOKEN: "private-test-token" } },
      );
      assert.equal(result.stdout, "SAFE");
      return fake.dependencies.installCandidate(input);
    },
  });
  assert.equal(report.stages.A.status, "passed");
});

test("local child output accepts its byte bound and refuses one byte more without retaining output", async () => {
  const bound = {
    name: "tensorrtPilot.commandOutputBytes",
    value: 64,
    unit: "bytes",
    refusal: "tensorrt-pilot-command-output-bytes-bound",
    remediation: "Measure and review the supported output.",
  };
  const timeout = {
    name: "tensorrtPilot.commandTimeoutMs",
    value: 5_000,
    unit: "milliseconds",
    refusal: "tensorrt-pilot-command-timeout-ms-bound",
    remediation: "Measure and review the supported duration.",
  };
  const accepted = await executeBoundedPilotChild(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(64))"],
    {},
    { timeout, output: bound },
  );
  assert.equal(Buffer.byteLength(accepted.stdout), bound.value);
  await assert.rejects(
    executeBoundedPilotChild(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(65))"],
      {},
      { timeout, output: bound },
    ),
    (error) =>
      error.code === bound.refusal &&
      error.details.observed === 65 &&
      error.details.scope.includes("one local subprocess stream") &&
      !error.message.includes("xxxxxxxx"),
  );
});

test("local child timeout refuses with the canonical code, observation, scope and remediation", async () => {
  const timeout = {
    name: "tensorrtPilot.commandTimeoutMs",
    value: 30,
    unit: "milliseconds",
    refusal: "tensorrt-pilot-command-timeout-ms-bound",
    remediation: "Measure and review the supported duration.",
  };
  const output = {
    name: "tensorrtPilot.commandOutputBytes",
    value: 128,
    unit: "bytes",
    refusal: "tensorrt-pilot-command-output-bytes-bound",
    remediation: "Measure and review the supported output.",
  };
  await assert.rejects(
    executeBoundedPilotChild(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 1000)"],
      {},
      { timeout, output },
    ),
    (error) =>
      error.code === timeout.refusal &&
      error.details.limit === timeout.name &&
      error.details.observed >= timeout.value &&
      error.details.scope.includes("wall duration") &&
      error.details.remediation === timeout.remediation,
  );
});
