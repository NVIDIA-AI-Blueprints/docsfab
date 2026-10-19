// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import * as packedCli from "../scripts/lib/packed-cli.mjs";
// @ts-expect-error The production entrypoint is a JavaScript module exercised directly here.
import { preparePackedCli } from "../scripts/prepare-packed-cli.mjs";
import { temporaryRoots } from "./helpers/temp.js";

const execute = promisify(execFile);
const REVISION = "a".repeat(40);
const FIXTURE_TIMEOUT_MS = 30_000;
const roots = temporaryRoots();
const { parseNpmPackJson } = packedCli;
const {
  assertPackedLicenseMatches,
  assertPackedNoticeMatches,
  assertPackedCandidateReproducible,
  installPackedDocsFab,
  parsePackedCandidateArguments,
  parsePackedVerificationArguments,
  preparePackedCandidate,
} = packedCli as typeof packedCli & {
  assertPackedLicenseMatches(packedBytes: unknown, acceptedBytes: Buffer): void;
  assertPackedNoticeMatches(packedBytes: unknown, acceptedBytes: Buffer): void;
  assertPackedCandidateReproducible(candidateBytes: Buffer, repeatedBytes: Buffer): void;
  installPackedDocsFab(input: {
    tarball: string;
    installRoot: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    offline?: boolean;
    runCommand?: typeof execute;
  }): Promise<{ installedPackageRoot: string; executable: string }>;
  parsePackedCandidateArguments(argv: string[]): { artifactDirectoryLeaf?: string };
  parsePackedVerificationArguments(argv: string[]): {
    artifactDirectoryLeaf?: string;
    outputDirectoryLeaf?: string;
  };
  preparePackedCandidate(input: {
    projectRoot: string;
    packDestination: string;
    env: NodeJS.ProcessEnv;
    artifactDirectoryLeaf?: string;
    runCommand?: typeof execute;
  }): Promise<{
    record: { name: string; version: string; integrity: string };
    tarball: string;
    integrity: string;
    sourceRevision: string;
    sourceVersion: string;
    sourceClean: boolean | null;
    origin: "fresh-pack" | "retained-artifact";
  }>;
};
const { materializePackageLicense, materializePackageNotice, PACKAGE_LICENSE_FILES } =
  (await import("../scripts/lib/package-license.mjs")) as {
    materializePackageLicense(sourcePath: string, packageLicensePath: string): Promise<void>;
    materializePackageNotice(sourcePath: string, packageNoticePath: string): Promise<void>;
    PACKAGE_LICENSE_FILES: readonly string[];
  };
const runtimeRoot = join(import.meta.dirname, "..");

type PackRecord = {
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string }>;
  entryCount: number;
  unpackedSize: number;
};

async function packFixture(
  sourceRoot: string,
  packRoot: string,
  name = "docsfab",
  version = "0.1.0",
): Promise<{ record: PackRecord; tarball: string }> {
  await mkdir(join(sourceRoot, "bin"), { recursive: true });
  await writeFile(
    join(sourceRoot, "package.json"),
    `${JSON.stringify({
      name,
      version,
      type: "module",
      bin: { [name]: "bin/cli.mjs" },
      files: ["bin"],
      scripts: { build: 'node -e ""' },
    })}\n`,
  );
  await writeFile(
    join(sourceRoot, "bin", "cli.mjs"),
    '#!/usr/bin/env node\nconsole.log("fixture executable");\n',
  );
  await chmod(join(sourceRoot, "bin", "cli.mjs"), 0o700);
  const lock = {
    name,
    version,
    lockfileVersion: 3,
    packages: { "": { name, version } },
  };
  await writeFile(join(sourceRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(join(sourceRoot, "npm-shrinkwrap.json"), `${JSON.stringify(lock, null, 2)}\n`);
  await mkdir(packRoot, { recursive: true });
  const packed = await execute(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        npm_config_cache: join(packRoot, "npm-cache"),
        npm_config_audit: "false",
      },
    },
  );
  const records = JSON.parse(packed.stdout) as PackRecord[];
  const record = records[0];
  if (!record) throw new Error("fixture npm pack returned no artifact record");
  return { record, tarball: join(packRoot, record.filename) };
}

async function writeMetadata(
  metadataPath: string,
  tarballPath: string,
  record: PackRecord,
  overrides: Record<string, unknown> = {},
  version = "0.1.0",
) {
  const bytes = await readFile(tarballPath);
  await writeFile(
    metadataPath,
    `${JSON.stringify({
      schemaVersion: 1,
      artifact: "docsfab.tgz",
      name: "docsfab",
      version,
      filename: `docsfab-${version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      sha1: createHash("sha1").update(bytes).digest("hex"),
      size: bytes.byteLength,
      entryCount: record.entryCount,
      unpackedSize: record.unpackedSize,
      sourceRevision: REVISION,
      ...overrides,
    })}\n`,
  );
}

async function fixture(version = "0.1.0") {
  const root = await roots.create("docsfab-packed-candidate-", { realpath: true });
  const projectRoot = join(root, "project");
  const buildRoot = join(root, "build");
  const artifactRoot = join(projectRoot, "artifacts");
  const tarballPath = join(artifactRoot, "docsfab.tgz");
  const metadataPath = join(artifactRoot, "metadata.json");
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, ".gitignore"), "artifacts/\npackage-candidate/\n");
  const packed = await packFixture(projectRoot, buildRoot, "docsfab", version);
  await execute("git", ["init", "-b", "main"], { cwd: projectRoot });
  await execute("git", ["config", "user.name", "Fixture"], { cwd: projectRoot });
  await execute("git", ["config", "user.email", "fixture@example.invalid"], { cwd: projectRoot });
  await execute("git", ["add", "."], { cwd: projectRoot });
  await execute("git", ["commit", "-m", "fixture source"], { cwd: projectRoot });
  await mkdir(artifactRoot);
  await copyFile(packed.tarball, tarballPath);
  await writeMetadata(metadataPath, tarballPath, packed.record, {}, version);
  const createPackRoot = async (name: string) => {
    const path = join(root, name);
    await mkdir(path);
    return path;
  };
  const env = {
    ...process.env,
    CI_COMMIT_SHA: REVISION,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  return {
    root,
    projectRoot,
    artifactRoot,
    tarballPath,
    metadataPath,
    record: packed.record,
    createPackRoot,
    env,
  };
}

describe("parseNpmPackJson", () => {
  const record = {
    name: "docsfab",
    version: "0.1.0",
    filename: "docsfab-0.1.0.tgz",
  };

  it("parses a bare npm pack --json array", () => {
    expect(parseNpmPackJson(`${JSON.stringify([record])}\n`)).toEqual([record]);
  });

  it("skips lefthook prepare stdout before the JSON array", () => {
    const stdout = `sync hooks: ✔️(pre-commit)\n${JSON.stringify([record])}\n`;
    expect(parseNpmPackJson(stdout)).toEqual([record]);
  });

  it("rejects stdout that never contains a JSON array", () => {
    expect(() => parseNpmPackJson("sync hooks: ✔️(pre-commit)\n")).toThrow(
      /did not emit a JSON array/u,
    );
  });
});

describe("packed package license", () => {
  it("packs the approved dual-license template for code and skills", async () => {
    const packageJson = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8")) as {
      files: string[];
    };
    const accepted = await readFile(join(runtimeRoot, "..", "..", "LICENSE"), "utf8");
    expect(accepted).toContain(
      "This code is dual-licensed with documentation/skills/assets under the CC-BY-4.0 AND source code under Apache-2.0 license terms.",
    );
    expect(PACKAGE_LICENSE_FILES).toEqual(["LICENSE", "LICENSE-CC-BY-4.0"]);
    for (const licenseFile of PACKAGE_LICENSE_FILES) {
      expect(packageJson.files).toContain(licenseFile);
      const source = await readFile(join(runtimeRoot, "..", "..", licenseFile), "utf8");
      expect(source).toBe(accepted);
    }
  });

  it("materializes the package license from the accepted repository license", async () => {
    const root = await roots.create("package-license-build-");
    const sourcePath = join(root, "LICENSE");
    const packageRoot = join(root, "packages", "runtime");
    const packageLicensePath = join(packageRoot, "LICENSE");
    const accepted = Buffer.from("Apache License Version 2.0\n");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(sourcePath, accepted);
    await writeFile(packageLicensePath, "stale license\n");

    await materializePackageLicense(sourcePath, packageLicensePath);

    expect(await readFile(packageLicensePath)).toEqual(accepted);
  });

  it("fails the package build when the accepted repository license is missing", async () => {
    const root = await roots.create("package-license-build-missing-");
    const packageLicensePath = join(root, "runtime", "LICENSE");
    await mkdir(join(root, "runtime"), { recursive: true });

    await expect(
      materializePackageLicense(join(root, "LICENSE"), packageLicensePath),
    ).rejects.toThrow();
    await expect(readFile(packageLicensePath)).rejects.toThrow();
  });

  it("accepts the extracted accepted license bytes", () => {
    const accepted = Buffer.from("Apache License Version 2.0\n");
    expect(() => assertPackedLicenseMatches(accepted, accepted)).not.toThrow();
  });

  it.each([undefined, Buffer.from("different license\n")])(
    "rejects a missing or different packed license (%s)",
    (packedBytes) => {
      const accepted = Buffer.from("Apache License Version 2.0\n");
      expect(() => assertPackedLicenseMatches(packedBytes, accepted)).toThrow(
        /packed LICENSE does not match/u,
      );
    },
  );
});

describe("packed package notice", () => {
  it("materializes the package NOTICE from the accepted repository NOTICE", async () => {
    const root = await roots.create("package-notice-build-");
    const sourcePath = join(root, "NOTICE");
    const packageRoot = join(root, "packages", "runtime");
    const packageNoticePath = join(packageRoot, "NOTICE");
    const accepted = Buffer.from("DocsFab\n");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(sourcePath, accepted);
    await writeFile(packageNoticePath, "stale notice\n");

    await materializePackageNotice(sourcePath, packageNoticePath);

    expect(await readFile(packageNoticePath)).toEqual(accepted);
  });

  it("fails the package build when the accepted repository NOTICE is missing", async () => {
    const root = await roots.create("package-notice-build-missing-");
    const packageNoticePath = join(root, "runtime", "NOTICE");
    await mkdir(join(root, "runtime"), { recursive: true });

    await expect(
      materializePackageNotice(join(root, "NOTICE"), packageNoticePath),
    ).rejects.toThrow();
    await expect(readFile(packageNoticePath)).rejects.toThrow();
  });

  it("accepts the extracted accepted NOTICE bytes", () => {
    const accepted = Buffer.from("DocsFab\n");
    expect(() => assertPackedNoticeMatches(accepted, accepted)).not.toThrow();
  });

  it.each([undefined, Buffer.from("different notice\n")])(
    "rejects a missing or different packed NOTICE (%s)",
    (packedBytes) => {
      const accepted = Buffer.from("DocsFab\n");
      expect(() => assertPackedNoticeMatches(packedBytes, accepted)).toThrow(
        /packed NOTICE does not match/u,
      );
    },
  );
});

describe("packed candidate input", () => {
  it("accepts no argument or one safe package-relative artifact leaf", () => {
    expect(parsePackedCandidateArguments([])).toEqual({});
    expect(parsePackedCandidateArguments(["--artifact-dir", "package-artifacts"])).toEqual({
      artifactDirectoryLeaf: "package-artifacts",
    });
    for (const argv of [
      ["--artifact-dir"],
      ["--artifact-dir", "../artifacts"],
      ["--artifact-dir", "nested/artifacts"],
      ["--artifact-dir", "/tmp/artifacts"],
      ["--unknown", "artifacts"],
    ]) {
      expect(() => parsePackedCandidateArguments(argv)).toThrow(/safe package-relative leaf/u);
    }
  });

  it("parses optional verifier candidate and output leaves in either order", () => {
    expect(
      parsePackedVerificationArguments([
        "--artifact-dir",
        "package-candidate",
        "--output-dir",
        "package-artifacts",
      ]),
    ).toEqual({
      artifactDirectoryLeaf: "package-candidate",
      outputDirectoryLeaf: "package-artifacts",
    });
    expect(
      parsePackedVerificationArguments([
        "--output-dir",
        "package-artifacts",
        "--artifact-dir",
        "package-candidate",
      ]),
    ).toEqual({
      artifactDirectoryLeaf: "package-candidate",
      outputDirectoryLeaf: "package-artifacts",
    });
    for (const argv of [
      ["--artifact-dir"],
      ["--artifact-dir", "../candidate"],
      ["--output-dir", "output", "--output-dir", "again"],
      ["--unknown", "candidate"],
    ]) {
      expect(() => parsePackedVerificationArguments(argv)).toThrow(/Packed CLI verification/u);
    }
  });

  it(
    "validates, snapshots, installs, and executes a retained candidate in independent roots",
    async () => {
      const item = await fixture();
      const packDestination = await item.createPackRoot("private-pack");
      const candidate = await preparePackedCandidate({
        projectRoot: item.projectRoot,
        packDestination,
        env: item.env,
        artifactDirectoryLeaf: "artifacts",
      });
      expect(candidate).toMatchObject({
        record: { name: "docsfab", version: "0.1.0" },
        origin: "retained-artifact",
        sourceRevision: REVISION,
      });
      expect(candidate.tarball).toBe(join(packDestination, "docsfab.tgz"));
      expect(candidate.integrity).toMatch(/^sha512-/u);

      await writeFile(item.tarballPath, "changed after verification\n");
      const installRoot = join(item.root, "install");
      const outsideRoot = join(item.root, "outside");
      await Promise.all([mkdir(installRoot), mkdir(outsideRoot)]);
      const installed = await installPackedDocsFab({
        tarball: candidate.tarball,
        installRoot,
        cwd: outsideRoot,
        env: item.env,
        offline: true,
      });
      expect(installed.executable.startsWith(installRoot)).toBe(true);
      expect(installed.installedPackageRoot.startsWith(installRoot)).toBe(true);
      const run = await execute(installed.executable, [], { cwd: outsideRoot, env: item.env });
      expect(run.stdout).toBe("fixture executable\n");
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "routes retained verification and offline installation through an explicit command runner",
    async () => {
      const item = await fixture();
      const commands: string[] = [];
      const runCommand = (async (command: string, args: string[], options: object) => {
        commands.push(command);
        if (command === "git") return { stdout: `${REVISION}\n`, stderr: "" };
        return execute(command, args, options);
      }) as typeof execute;
      const candidate = await preparePackedCandidate({
        projectRoot: item.projectRoot,
        packDestination: await item.createPackRoot("bounded-pack"),
        env: { ...item.env, CI_COMMIT_SHA: undefined },
        artifactDirectoryLeaf: "artifacts",
        runCommand,
      });
      const installRoot = join(item.root, "bounded-install");
      await mkdir(installRoot);
      await installPackedDocsFab({
        tarball: candidate.tarball,
        installRoot,
        cwd: item.projectRoot,
        env: item.env,
        offline: true,
        runCommand,
      });
      expect(commands).toEqual(["git", "tar", "npm"]);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it("preserves a bounded tar refusal instead of reporting a malformed archive", async () => {
    const item = await fixture();
    const refusal = Object.assign(new Error("bounded tar output"), {
      code: "tensorrt-pilot-command-output-bytes-bound",
      details: { limit: "tensorrtPilot.commandOutputBytes" },
    });
    const runCommand = (async (command: string, args: string[], options: object) => {
      if (command === "tar") throw refusal;
      return execute(command, args, options);
    }) as typeof execute;
    await expect(
      preparePackedCandidate({
        projectRoot: item.projectRoot,
        packDestination: await item.createPackRoot("bounded-tar"),
        env: item.env,
        artifactDirectoryLeaf: "artifacts",
        runCommand,
      }),
    ).rejects.toBe(refusal);
  });

  it.each(["docsfab.tgz", "metadata.json"])(
    "rejects a missing retained %s",
    async (name) => {
      const item = await fixture();
      await unlink(join(item.artifactRoot, name));
      await expect(
        preparePackedCandidate({
          projectRoot: item.projectRoot,
          packDestination: await item.createPackRoot(`missing-${name}`),
          env: item.env,
          artifactDirectoryLeaf: "artifacts",
        }),
      ).rejects.toThrow();
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "rejects retained bytes that do not match the sidecar",
    async () => {
      const item = await fixture();
      const corrupted = Buffer.from(await readFile(item.tarballPath));
      corrupted[0] = (corrupted[0] ?? 0) ^ 1;
      await writeFile(item.tarballPath, corrupted);
      await expect(
        preparePackedCandidate({
          projectRoot: item.projectRoot,
          packDestination: await item.createPackRoot("corrupt-pack"),
          env: item.env,
          artifactDirectoryLeaf: "artifacts",
        }),
      ).rejects.toThrow(/do not match verified integrity/u);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "rejects sidecar package identity and source provenance mismatches",
    async () => {
      const wrongIdentity = await fixture();
      await writeMetadata(
        wrongIdentity.metadataPath,
        wrongIdentity.tarballPath,
        wrongIdentity.record,
        { name: "other-package" },
      );
      await expect(
        preparePackedCandidate({
          projectRoot: wrongIdentity.projectRoot,
          packDestination: await wrongIdentity.createPackRoot("identity-pack"),
          env: wrongIdentity.env,
          artifactDirectoryLeaf: "artifacts",
        }),
      ).rejects.toThrow(/name or version does not match/u);

      const wrongProvenance = await fixture();
      await writeMetadata(
        wrongProvenance.metadataPath,
        wrongProvenance.tarballPath,
        wrongProvenance.record,
        { sourceRevision: "b".repeat(40) },
      );
      await expect(
        preparePackedCandidate({
          projectRoot: wrongProvenance.projectRoot,
          packDestination: await wrongProvenance.createPackRoot("provenance-pack"),
          env: wrongProvenance.env,
          artifactDirectoryLeaf: "artifacts",
        }),
      ).rejects.toThrow(/source revision does not match/u);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "rejects an archive identity mismatch even when sidecar checksums are self-consistent",
    async () => {
      const item = await fixture();
      const impostor = await packFixture(
        join(item.root, "impostor-source"),
        join(item.root, "impostor-build"),
        "impostor",
      );
      await copyFile(impostor.tarball, item.tarballPath);
      await writeMetadata(item.metadataPath, item.tarballPath, impostor.record);
      await expect(
        preparePackedCandidate({
          projectRoot: item.projectRoot,
          packDestination: await item.createPackRoot("impostor-pack"),
          env: item.env,
          artifactDirectoryLeaf: "artifacts",
        }),
      ).rejects.toThrow(/archive identity does not match verified metadata/u);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "keeps the default no-argument path as a fresh pack",
    async () => {
      const item = await fixture();
      const packDestination = await item.createPackRoot("default-pack");
      const candidate = await preparePackedCandidate({
        projectRoot: item.projectRoot,
        packDestination,
        env: item.env,
      });
      expect(candidate).toMatchObject({
        record: { name: "docsfab", version: "0.1.0" },
        origin: "fresh-pack",
        sourceRevision: REVISION,
      });
      expect(candidate.tarball.startsWith(packDestination)).toBe(true);
      expect(candidate.integrity).toBe(candidate.record.integrity);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it("produces one retained candidate that a consumer and clean repeat bind to the same bytes", async () => {
    const item = await fixture();
    const mainEnv = {
      ...item.env,
      CI_COMMIT_BRANCH: "main",
      CI_DEFAULT_BRANCH: "main",
      CI_COMMIT_SHORT_SHA: REVISION.slice(0, 8),
      DOCSFAB_PACKAGE_FINAL_VERSION: `0.1.0-main.${REVISION.slice(0, 8)}`,
    };
    const logs: string[] = [];
    const produced = await preparePackedCli({
      argv: ["--output-dir", "package-candidate"],
      env: mainEnv,
      projectRoot: item.projectRoot,
      log: (line: string) => logs.push(line),
    });
    const metadata = JSON.parse(
      await readFile(join(item.projectRoot, "package-candidate", "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(
      [
        "artifact",
        "entryCount",
        "filename",
        "integrity",
        "name",
        "schemaVersion",
        "sha1",
        "size",
        "sourceClean",
        "sourceRevision",
        "sourceVersion",
        "unpackedSize",
        "version",
      ].sort(),
    );
    expect(metadata).toMatchObject({
      schemaVersion: 2,
      sourceVersion: "0.1.0",
      sourceClean: true,
      version: `0.1.0-main.${REVISION.slice(0, 8)}`,
    });
    expect(produced).toMatchObject({
      name: "docsfab",
      version: `0.1.0-main.${REVISION.slice(0, 8)}`,
      sourceRevision: REVISION,
      sourceClean: true,
    });
    expect(logs[0]).toContain(produced.integrity);
    expect(logs[0]).toContain(REVISION);

    // The independent consumer must continue reading schema-v1 retained artifacts.
    const v1Consumed = await preparePackedCandidate({
      projectRoot: item.projectRoot,
      packDestination: await item.createPackRoot("candidate-v1-consumer"),
      env: item.env,
      artifactDirectoryLeaf: "artifacts",
    });
    expect(v1Consumed.sourceVersion).toBe("0.1.0");
    expect(v1Consumed.sourceClean).toBeNull();
    const consumed = await preparePackedCandidate({
      projectRoot: item.projectRoot,
      packDestination: await item.createPackRoot("candidate-consumer"),
      env: mainEnv,
      artifactDirectoryLeaf: "package-candidate",
    });
    const repeated = await preparePackedCandidate({
      projectRoot: item.projectRoot,
      packDestination: await item.createPackRoot("candidate-repeat"),
      env: mainEnv,
    });
    const [consumedBytes, repeatedBytes] = await Promise.all([
      readFile(consumed.tarball),
      readFile(repeated.tarball),
    ]);
    expect(consumed.record.version).toBe(produced.version);
    expect(consumed.integrity).toBe(produced.integrity);
    expect(consumedBytes).toEqual(
      await readFile(join(item.projectRoot, "package-candidate", "docsfab.tgz")),
    );
    expect(() => assertPackedCandidateReproducible(consumedBytes, repeatedBytes)).not.toThrow();
    repeatedBytes[0] = (repeatedBytes[0] ?? 0) ^ 1;
    expect(() => assertPackedCandidateReproducible(consumedBytes, repeatedBytes)).toThrow(
      /did not reproduce/u,
    );
  }, 60_000);

  it("packs and retains an exact main version from a source with build metadata", async () => {
    const item = await fixture("0.0.9+build.7");
    const mainEnv = {
      ...item.env,
      CI_COMMIT_BRANCH: "main",
      CI_DEFAULT_BRANCH: "main",
      CI_COMMIT_SHORT_SHA: REVISION.slice(0, 8),
    };
    const finalVersion = `0.0.9+build.7-main.${REVISION.slice(0, 8)}`;
    const produced = await preparePackedCli({
      argv: ["--output-dir", "package-candidate"],
      env: mainEnv,
      projectRoot: item.projectRoot,
      log: () => {},
    });
    expect(produced).toMatchObject({ version: finalVersion, sourceClean: true });
    const metadata = JSON.parse(
      await readFile(join(item.projectRoot, "package-candidate", "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schemaVersion: 2,
      version: finalVersion,
      sourceVersion: "0.0.9+build.7",
      sourceClean: true,
    });
    const consumed = await preparePackedCandidate({
      projectRoot: item.projectRoot,
      packDestination: await item.createPackRoot("build-metadata-consumer"),
      env: mainEnv,
      artifactDirectoryLeaf: "package-candidate",
    });
    expect(consumed.record.version).toBe(finalVersion);
    expect(await readFile(consumed.tarball)).toEqual(
      await readFile(join(item.projectRoot, "package-candidate", "docsfab.tgz")),
    );

    for (const invalidVersion of [
      `0.0.9+build..7-main.${REVISION.slice(0, 8)}`,
      `0.0.8+build.7-main.${REVISION.slice(0, 8)}`,
      "0.0.9+build.7-main.nothex12",
    ]) {
      await expect(
        preparePackedCandidate({
          projectRoot: item.projectRoot,
          packDestination: await item.createPackRoot(
            `invalid-${invalidVersion.replaceAll("+", "_")}`,
          ),
          env: { ...mainEnv, DOCSFAB_PACKAGE_FINAL_VERSION: invalidVersion },
        }),
      ).rejects.toThrow(/not bound to the source package version/u);
    }
  }, 60_000);

  it("rejects a retained candidate tarball that contains a compiled test", async () => {
    const root = await roots.create("packed-cli-contaminated-candidate-", { realpath: true });
    const fixtureRepositoryRoot = join(root, "fixture-repo");
    const projectRoot = join(fixtureRepositoryRoot, "packages", "runtime");
    const artifactLeaf = "candidate";
    const artifactRoot = join(projectRoot, artifactLeaf);
    const sourceRoot = join(root, "candidate-source");
    const packRoot = join(root, "pack");
    const sourceRevision = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: runtimeRoot })
    ).stdout.trim();
    const env = {
      ...process.env,
      CI_COMMIT_SHA: sourceRevision,
      npm_config_cache: join(root, "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(fixtureRepositoryRoot, "config"), { recursive: true });
    await copyFile(
      join(runtimeRoot, "../../config/limits.catalog.json"),
      join(fixtureRepositoryRoot, "config/limits.catalog.json"),
    );
    await copyFile(join(runtimeRoot, "../../NOTICE"), join(fixtureRepositoryRoot, "NOTICE"));
    for (const relativePath of [
      "package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "scripts/verify-packed-cli.mjs",
      "scripts/verify-release-artifact.mjs",
      "scripts/lib/packed-cli.mjs",
      "scripts/lib/installed-version-identity.mjs",
      "scripts/lib/installed-help-contract.mjs",
      "scripts/lib/leased-run-record.mjs",
      "scripts/lib/package-license.mjs",
      "scripts/lib/packed-cli-diagnostics.mjs",
      "src/config/executable-route-urls.js",
      "src/config/private-route-urls.js",
    ]) {
      const destination = join(projectRoot, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(runtimeRoot, relativePath), destination);
    }

    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    const sourcePackage = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8")) as {
      version: string;
    };
    await writeFile(
      join(sourceRoot, "package.json"),
      `${JSON.stringify({
        name: "docsfab",
        version: sourcePackage.version,
        type: "module",
        files: ["dist"],
      })}\n`,
    );
    await writeFile(join(sourceRoot, "dist", "contaminated.test.js"), "export {};\n");
    await mkdir(packRoot);
    const packed = await execute(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot],
      { cwd: sourceRoot, env },
    );
    const record = (JSON.parse(packed.stdout) as PackRecord[])[0];
    if (!record) throw new Error("contaminated npm pack fixture returned no record");

    await mkdir(artifactRoot);
    await copyFile(join(packRoot, record.filename), join(artifactRoot, "docsfab.tgz"));
    await writeFile(
      join(artifactRoot, "metadata.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          artifact: "docsfab.tgz",
          name: record.name,
          version: record.version,
          filename: record.filename,
          integrity: record.integrity,
          sha1: record.shasum,
          size: record.size,
          entryCount: record.entryCount,
          unpackedSize: record.unpackedSize,
          sourceRevision,
        },
        null,
        2,
      )}\n`,
    );

    let failure: { code?: number; stderr?: string } | undefined;
    try {
      await execute(
        process.execPath,
        [join(projectRoot, "scripts", "verify-packed-cli.mjs"), "--artifact-dir", artifactLeaf],
        { cwd: projectRoot, env },
      );
    } catch (error) {
      failure = error as { code?: number; stderr?: string };
    }
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain("compiled test file dist/contaminated.test.js was packed");
  }, 60_000);
});
