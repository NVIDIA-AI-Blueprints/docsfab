// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const roots = [];
const VERSION = "9.8.7-main.abcdef12";
const runtimeManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const packageRegistry = new URL("https://packages.example.test/docsfab/");
const packageName = "docsfab";
const TARBALL_URL = new URL(`${packageName}/-/${packageName}-${VERSION}.tgz`, packageRegistry).href;
const npmAuthScope = `//${packageRegistry.host}${packageRegistry.pathname.endsWith("/") ? packageRegistry.pathname : `${packageRegistry.pathname}/`}`;

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture({
  tarballUrl = TARBALL_URL,
  reportedShasum,
  selfTestStatus = "passed",
  installDrift = false,
  registry = packageRegistry.href,
} = {}) {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-package-url-test-")));
  roots.push(root);
  const controllerRoot = join(root, "controller");
  const script = join(controllerRoot, "scripts/package-url-acceptance.mjs");
  await mkdir(join(controllerRoot, "scripts"), { recursive: true });
  await copyFile(new URL("./package-url-acceptance.mjs", import.meta.url), script);
  await writeFile(
    join(controllerRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      ...(registry === null ? {} : { publishConfig: { registry } }),
    }),
  );
  const fakeBin = join(root, "fake-bin");
  const outputRoot = join(root, "evidence");
  const npmCalls = join(root, "npm-calls.jsonl");
  const packageSourceRoot = join(root, "package");
  const archivePath = join(root, "fixture-package.tgz");
  const packageBin = join(packageSourceRoot, "bin", "docsfab");
  await mkdir(fakeBin);
  await mkdir(outputRoot);
  await mkdir(join(packageSourceRoot, "bin"), { recursive: true });
  const cliSource = `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.PI_OFFLINE !== "1" || process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || process.env.MODEL_API_KEY || process.env.npm_config_userconfig || process.env.NODE_OPTIONS || process.env.NODE_PATH || !process.env.HOME.endsWith("/home")) process.exit(31);
if (args[0] === "--version") console.log(${JSON.stringify(VERSION)});
else if (args[0] === "--help") console.log("DocsFab help");
else if (args[0] === "list") console.log("Available workflows");
else if (args[0] === "test" && args[1] === "--json") console.log(JSON.stringify({ kind: "docsfab-offline-product-test", status: ${JSON.stringify(selfTestStatus)} }));
else process.exit(32);
`;
  const packageManifest = JSON.stringify({
    name: "docsfab",
    version: VERSION,
    type: "module",
    bin: { docsfab: "bin/docsfab" },
    engines: { node: ">=24.0.0" },
  });
  await writeFile(join(packageSourceRoot, "package.json"), `${packageManifest}\n`);
  await writeFile(packageBin, cliSource, { mode: 0o700 });
  await chmod(packageBin, 0o700);
  await execute("tar", ["-czf", archivePath, "-C", root, "package"]);
  const packageBytes = await readFile(archivePath);
  const packageSha1 = createHash("sha1").update(packageBytes).digest("hex");
  const packageIntegrity = `sha512-${createHash("sha512").update(packageBytes).digest("base64")}`;
  const packageSize = packageBytes.byteLength;
  const fakeNpmPath = join(fakeBin, "npm");
  await writeFile(
    fakeNpmPath,
    `#!${process.execPath}
const { appendFile, chmod, copyFile, cp, mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
async function main() {
const args = process.argv.slice(2);
const userConfig = process.env.npm_config_userconfig ? await readFile(process.env.npm_config_userconfig, "utf8") : "";
await appendFile(${JSON.stringify(npmCalls)}, JSON.stringify({ args, hasToken: Boolean(process.env.NPM_TOKEN), hasExpectedToken: process.env.NPM_TOKEN === "package-read-test-token", hasNodeAuthToken: process.env.NODE_AUTH_TOKEN === "node-auth-test-token", hasModelKey: Boolean(process.env.MODEL_API_KEY), hasTokenInterpolation: userConfig.includes("\${NPM_TOKEN}"), cache: process.env.npm_config_cache, userconfig: process.env.npm_config_userconfig, ignoreScripts: process.env.npm_config_ignore_scripts }) + "\\n");
if (args[0] === "--version") { console.log("11.4.2"); process.exit(0); }
if (args[0] === "view") {
  console.log(JSON.stringify({
    version: ${JSON.stringify(VERSION)},
    gitHead: "${"a".repeat(40)}",
    dist: { tarball: ${JSON.stringify(tarballUrl)}, integrity: ${JSON.stringify(packageIntegrity)}, shasum: ${JSON.stringify(reportedShasum ?? packageSha1)} }
  }));
  process.exit(0);
}
if (args[0] === "install") {
  const prefix = args[args.indexOf("--prefix") + 1];
  const packageRoot = join(prefix, "lib", "node_modules", "docsfab");
  await cp(${JSON.stringify(packageSourceRoot)}, packageRoot, { recursive: true });
  if (${JSON.stringify(installDrift)}) await writeFile(join(packageRoot, "bin", "docsfab"), (await readFile(join(packageRoot, "bin", "docsfab"), "utf8")) + "\\n// drift\\n");
  await mkdir(join(prefix, "bin"), { recursive: true });
  await copyFile(join(packageRoot, "bin", "docsfab"), join(prefix, "bin", "docsfab"));
  await chmod(join(prefix, "bin", "docsfab"), 0o700);
  process.exit(0);
}
if (args[0] === "pack") {
  const destination = args[args.indexOf("--pack-destination") + 1];
  const filename = "docsfab-${VERSION}.tgz";
  await copyFile(${JSON.stringify(archivePath)}, join(destination, filename));
  console.log(JSON.stringify([{ name: "docsfab", version: ${JSON.stringify(VERSION)}, filename }]));
  process.exit(0);
}
process.exit(90);
}
main().catch(async (error) => {
  await appendFile(${JSON.stringify(npmCalls)}, JSON.stringify({ fakeFailure: String(error?.stack ?? error) }) + "\\n");
  process.exit(91);
});
`,
    { mode: 0o700 },
  );
  await chmod(fakeNpmPath, 0o700);
  return {
    root,
    controllerRoot,
    script,
    fakeBin,
    outputRoot,
    npmCalls,
    packageSha1,
    packageIntegrity,
    packageSize,
  };
}

describe("package URL installation acceptance", () => {
  it("refuses an absent package registry before invoking npm, including the public manifest", async () => {
    const state = await fixture({ registry: null });
    const script = runtimeManifest.publishConfig?.registry
      ? state.script
      : resolve("scripts/package-url-acceptance.mjs");
    await expect(
      execute(process.execPath, [script, "--version", VERSION, "--output-dir", state.outputRoot], {
        cwd: state.root,
        env: { PATH: `${state.fakeBin}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("package.json does not declare its npm registry."),
    });
    await expect(readFile(state.npmCalls)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves and installs the exact metadata URL, then runs the installed CLI offline without inherited credentials", async () => {
    const state = await fixture();
    const script = state.script;
    const userconfig = join(state.root, "private.npmrc");
    await writeFile(userconfig, `${npmAuthScope}:_authToken=${"${NPM_TOKEN}"}\n`, { mode: 0o600 });
    let result;
    try {
      result = await execute(
        process.execPath,
        [
          script,
          "--version",
          VERSION,
          "--output-dir",
          state.outputRoot,
          "--npm-userconfig",
          userconfig,
          "--source-sha",
          "a".repeat(40),
          "--package-id",
          "1173481",
          "--pipeline-id",
          "72513951",
        ],
        {
          cwd: state.root,
          env: {
            ...process.env,
            PATH: `${state.fakeBin}:${process.env.PATH ?? ""}`,
            NPM_TOKEN: "package-read-test-token",
            NODE_AUTH_TOKEN: "node-auth-test-token",
            MODEL_API_KEY: "model-secret-that-must-not-be-retained",
            NODE_OPTIONS: "--no-warnings",
            NODE_PATH: "/private/test-module-path",
          },
        },
      );
    } catch (error) {
      const calls = await readFile(state.npmCalls, "utf8").catch(() => "");
      throw new Error(`${error.message}\n${calls}`);
    }

    expect(result.stdout).toContain(
      `PASS package URL installation acceptance for docsfab@${VERSION}`,
    );
    expect(result.stdout).not.toContain("package-read-test-token");
    expect(result.stdout).not.toContain("node-auth-test-token");
    expect(result.stderr).toBe("");
    const evidence = JSON.parse(
      await readFile(join(state.outputRoot, "package-url-acceptance.json"), "utf8"),
    );
    expect(evidence).toMatchObject({
      status: "passed",
      provenance: {
        operatorSupplied: {
          sourceSha: "a".repeat(40),
          packageId: "1173481",
          pipelineId: "72513951",
        },
        registryReported: { gitHead: "a".repeat(40) },
      },
      package: {
        name: "docsfab",
        version: VERSION,
        tarballUrl: TARBALL_URL,
        registryDigests: {
          integrity: state.packageIntegrity,
          shasum: state.packageSha1,
        },
      },
      host: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        npm: "11.4.2",
      },
    });
    expect(evidence.isolation.lifecycleScripts).toBe(
      "disabled for metadata, install, and byte-verification commands",
    );
    expect(evidence.isolation.enginePolicy).toBe("strict; npm install uses --engine-strict");
    expect(evidence.commands.map(({ name, exitCode }) => [name, exitCode])).toEqual([
      ["npm-version", 0],
      ["resolve-package-metadata", 0],
      ["install-package-url", 0],
      ["download-package-bytes", 0],
      ["version", 0],
      ["help", 0],
      ["list", 0],
      ["offline-self-test", 0],
    ]);
    expect(evidence.downloadedBytes).toEqual({
      sha1: state.packageSha1,
      integrity: state.packageIntegrity,
      size: state.packageSize,
    });
    expect(evidence.checks).toEqual([
      { name: "downloaded-bytes-match-registry-digest", status: "passed" },
      { name: "installed-tree-matches-verified-archive", status: "passed" },
    ]);
    const retained = JSON.stringify(evidence);
    expect(retained).not.toContain("package-read-test-token");
    expect(retained).not.toContain("node-auth-test-token");
    expect(retained).not.toContain("model-secret");

    const npmCalls = (await readFile(state.npmCalls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(npmCalls[1].args).toContain(`docsfab@${VERSION}`);
    expect(npmCalls[2].args.at(-1)).toBe(TARBALL_URL);
    expect(npmCalls[1].hasExpectedToken).toBe(true);
    expect(npmCalls[1].hasNodeAuthToken).toBe(true);
    expect(npmCalls[1].hasTokenInterpolation).toBe(true);
    expect(npmCalls[2].hasExpectedToken).toBe(true);
    expect(npmCalls[2].hasNodeAuthToken).toBe(true);
    expect(npmCalls[2].hasTokenInterpolation).toBe(true);
    expect(npmCalls[2].hasModelKey).toBe(false);
    expect(npmCalls[3].hasExpectedToken).toBe(true);
    expect(npmCalls[3].hasNodeAuthToken).toBe(true);
    expect(npmCalls[3].args.at(-1)).toBe(TARBALL_URL);
    expect(npmCalls[1].cache).toContain("docsfab-package-url-");
    expect(npmCalls[2].userconfig).toBe(userconfig);
    expect(npmCalls[2].ignoreScripts).toBe("true");
    expect(npmCalls[2].args).toContain("--engine-strict");
  });

  it("retains actual byte digests and fails when the tarball differs from registry metadata", async () => {
    const state = await fixture({ reportedShasum: "c".repeat(40) });
    const script = state.script;
    await expect(
      execute(process.execPath, [script, "--version", VERSION, "--output-dir", state.outputRoot], {
        cwd: state.root,
        env: { ...process.env, PATH: `${state.fakeBin}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("do not match the registry SHA-1") });
    const evidence = JSON.parse(
      await readFile(join(state.outputRoot, "package-url-acceptance.json"), "utf8"),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.downloadedBytes).toEqual({
      sha1: state.packageSha1,
      integrity: state.packageIntegrity,
      size: state.packageSize,
    });
    expect(evidence.commands.at(-1)).toMatchObject({
      name: "download-package-bytes",
      exitCode: 0,
    });
    expect(evidence.checks).toEqual([
      { name: "downloaded-bytes-match-registry-digest", status: "failed" },
    ]);
  });

  it("rejects installed bytes that drift from the independently verified archive", async () => {
    const state = await fixture({ installDrift: true });
    const script = state.script;
    await expect(
      execute(process.execPath, [script, "--version", VERSION, "--output-dir", state.outputRoot], {
        cwd: state.root,
        env: { ...process.env, PATH: `${state.fakeBin}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "installed package content differs from the digest-verified archive",
      ),
    });
    const evidence = JSON.parse(
      await readFile(join(state.outputRoot, "package-url-acceptance.json"), "utf8"),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.checks).toEqual([
      { name: "downloaded-bytes-match-registry-digest", status: "passed" },
      { name: "installed-tree-matches-verified-archive", status: "failed" },
    ]);
  });

  it("fails when the offline self-test JSON parses but reports a failed status", async () => {
    const state = await fixture({ selfTestStatus: "failed" });
    const script = state.script;
    await expect(
      execute(process.execPath, [script, "--version", VERSION, "--output-dir", state.outputRoot], {
        cwd: state.root,
        env: { ...process.env, PATH: `${state.fakeBin}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("did not report a passed offline product test"),
    });
    const evidence = JSON.parse(
      await readFile(join(state.outputRoot, "package-url-acceptance.json"), "utf8"),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.commands.at(-1)).toMatchObject({
      name: "offline-self-test",
      exitCode: 0,
      resultKind: "docsfab-offline-product-test",
      resultStatus: "failed",
    });
  });

  it("rejects a non-exact version before invoking npm", async () => {
    const state = await fixture();
    const script = state.script;
    await expect(
      execute(process.execPath, [script, "--version", "latest", "--output-dir", state.outputRoot], {
        cwd: state.root,
        env: { ...process.env, PATH: `${state.fakeBin}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("exact semantic version") });
    await expect(readFile(state.npmCalls, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a metadata URL outside the configured registry and retains sanitized failure evidence", async () => {
    const state = await fixture({
      tarballUrl: "https://untrusted.example.test/package.tgz",
    });
    const script = state.script;
    await expect(
      execute(process.execPath, [script, "--version", VERSION, "--output-dir", state.outputRoot], {
        cwd: state.root,
        env: { ...process.env, PATH: `${state.fakeBin}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("package URL with unsupported credentials or parameters"),
    });
    const evidence = JSON.parse(
      await readFile(join(state.outputRoot, "package-url-acceptance.json"), "utf8"),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.commands.at(-1)).toMatchObject({
      name: "resolve-package-metadata",
      exitCode: 0,
    });
    expect(JSON.stringify(evidence)).not.toContain("untrusted.example.test");
  });

  it("rejects a symlinked evidence destination before creating a directory under the source tree", async () => {
    const state = await fixture();
    const link = join(state.root, "source-alias");
    await symlink(state.controllerRoot, link);
    const target = join(link, "acceptance-evidence");
    const script = state.script;
    await expect(
      execute(process.execPath, [script, "--version", VERSION, "--output-dir", target], {
        cwd: state.root,
        env: { ...process.env, PATH: `${state.fakeBin}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("evidence output must be outside") });
    await expect(readFile(join(state.controllerRoot, "acceptance-evidence"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });
});
