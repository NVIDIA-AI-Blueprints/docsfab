// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readBuildIdentity, writeBuildIdentityModule } from "./build-identity.mjs";
import { EnsureDerivedRefusal, ensureDerived } from "./ensure-derived.mjs";
import { copyJsOnlyDistModules } from "./js-only-dist-modules.mjs";
import {
  materializePackageLicense,
  materializePackageNotice,
  PACKAGE_LICENSE_FILES,
} from "./lib/package-license.mjs";
import { replaceDirectoryAfterBuild } from "./lib/staged-output.mjs";
import { resolveTypeScriptCompiler } from "./resolve-typescript-compiler.mjs";

const execute = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageOutputDirectory = join(projectRoot, "dist");
const outputDirectory = isolatedOutputDirectory(process.argv.slice(2)) ?? packageOutputDirectory;
const repositoryRoot = resolve(projectRoot, "..", "..");
const knowledgeSourceDirectory = join(repositoryRoot, "packages", "knowledge", "src");
const knowledgeOutputPath = ["knowledge-provider", "src"];
const knowledgeProviderFiles = [
  "attributed-snapshot.mjs",
  "backend.mjs",
  "evidence-source.mjs",
  "exports.mjs",
  "first-pass/error.mjs",
  "first-pass/evidence-frame.mjs",
  "first-pass-limits.generated.mjs",
  "first-pass/scan.mjs",
  "first-pass/parse.mjs",
  "first-pass/assess.mjs",
  "first-pass/partial.mjs",
  "first-pass-support.mjs",
  "first-pass.mjs",
  "model.mjs",
  "store.mjs",
];
const compiler = resolveTypeScriptCompiler();

if (dirname(packageOutputDirectory) !== projectRoot || packageOutputDirectory === projectRoot) {
  throw new Error("Refusing to clean an unsafe package build output path.");
}

/**
 * `--output-dir <path>` builds into another package root, so a test can run its
 * own build without replacing the `dist/` other processes are using. The path
 * must be an absolute `dist` that does not exist yet, inside an existing
 * directory that holds none of the license files the build writes beside it,
 * so the build never moves, deletes, or overwrites an existing file.
 *
 * @param {readonly string[]} args
 * @returns {string | undefined}
 */
function isolatedOutputDirectory(args) {
  if (args.length === 0) return undefined;
  const [option, path, ...rest] = args;
  const packageRootFiles = [...PACKAGE_LICENSE_FILES, "NOTICE"];
  if (
    option !== "--output-dir" ||
    path === undefined ||
    rest.length > 0 ||
    resolve(path) !== path ||
    basename(path) !== "dist" ||
    existsSync(path) ||
    !existsSync(dirname(path)) ||
    packageRootFiles.some((file) => existsSync(join(dirname(path), file)))
  ) {
    throw new Error(
      `Usage: node scripts/build-package.mjs [--output-dir <absolute path of a dist directory that does not exist yet, inside an existing directory without ${packageRootFiles.join(", ")}>].`,
    );
  }
  return path;
}

class CompilerFailure extends Error {
  /** @param {string} diagnostics */
  constructor(diagnostics) {
    super("TypeScript reported errors while building the runtime package.");
    this.diagnostics = diagnostics;
  }
}

// Generated inputs are made current before staging starts, so a refusal
// leaves dist/ untouched.
if (await derivedOutputsReady()) {
  try {
    await replaceDirectoryAfterBuild(outputDirectory, buildInto);
  } catch (error) {
    if (!(error instanceof CompilerFailure)) throw error;
    process.stderr.write(
      `${error.diagnostics.trimEnd()}\nTypeScript build failed; dist/ is unchanged.\n`,
    );
    process.exitCode = 1;
  }
}

async function derivedOutputsReady() {
  try {
    await ensureDerived();
    return true;
  } catch (error) {
    // Handles exactly the hook's own refusals; any other error keeps its stack.
    if (!(error instanceof EnsureDerivedRefusal)) throw error;
    process.stderr.write(`ensure-derived: ${error.message}\nBuild stopped; dist/ is unchanged.\n`);
    process.exitCode = 1;
    return false;
  }
}

/** @param {string} staging */
async function buildInto(staging) {
  await compile(staging);
  const knowledgeOutputDirectory = join(staging, ...knowledgeOutputPath);
  await mkdir(knowledgeOutputDirectory, { recursive: true });
  await Promise.all(
    knowledgeProviderFiles.map(async (filename) => {
      const destination = join(knowledgeOutputDirectory, filename);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(knowledgeSourceDirectory, filename), destination);
    }),
  );
  await copyJsOnlyDistModules(projectRoot, staging);
  // The license files belong to the package root the output is built for.
  const packageRoot = dirname(outputDirectory);
  for (const licenseFile of PACKAGE_LICENSE_FILES) {
    await materializePackageLicense(
      join(repositoryRoot, licenseFile),
      join(packageRoot, licenseFile),
    );
  }
  await materializePackageNotice(join(repositoryRoot, "NOTICE"), join(packageRoot, "NOTICE"));
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  await writeBuildIdentityModule(
    staging,
    await readBuildIdentity(repositoryRoot, { version: packageJson.version }),
  );
  await chmod(join(staging, "launcher.js"), 0o755);
}

/**
 * `tsc` still emits after type errors, so its exit status alone decides.
 *
 * @param {string} staging
 */
async function compile(staging) {
  try {
    await execute(compiler, ["-p", join(projectRoot, "tsconfig.json"), "--outDir", staging], {
      cwd: projectRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const output = /** @type {{ stdout?: string; stderr?: string }} */ (error);
    if (!output.stdout && !output.stderr) throw error;
    throw new CompilerFailure(`${output.stdout ?? ""}${output.stderr ?? ""}`);
  }
}
