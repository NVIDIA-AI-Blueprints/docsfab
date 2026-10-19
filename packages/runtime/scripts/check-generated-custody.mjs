#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Attest the generated outputs that host source imports, in one Node process.
 *
 * Usage:
 *   node packages/runtime/scripts/check-generated-custody.mjs
 *
 * The deploy helper generated-custody.sh runs this from a reviewed clone
 * before a tool's first Node run of clone host source. For each generator, in
 * order, it lists the generator's outputs, refuses a listed output that is a
 * symbolic link or not a regular file, then runs that generator's own `--check`.
 * It imports the generators instead of starting one process per step, because
 * every wrapper invocation pays for this attestation. It never generates or
 * repairs anything.
 *
 * Exit 0 prints one line, `attested <N> outputs`, N counted from the
 * generators' own listings; the shell helper requires it, so a checker that
 * exits 0 having attested nothing does not pass. A refusal exits 1 and prints
 * its code on the first line of standard output and what is wrong on the rest;
 * the shell helper adds the remediation for that code.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Generated outputs that are absent, irregular or stale: generating fixes them. */
export const STALE = "SOURCE_CUSTODY_GENERATED_STALE";
/** A generator that cannot load its tracked inputs: generating would fail as well. */
export const GENERATOR_FAILED = "SOURCE_CUSTODY_GENERATOR_FAILED";

// The generators whose outputs host source imports. `parse` and `run` are the
// argument parser and tool each generator's own command line uses, so check
// mode here gets the same options as `<generator> --check`. `prepare` loads the
// tracked inputs once for both the listing and the check, with each
// generator's dependency-free YAML parser: the attestation then rests on
// tracked bytes alone, and the generators render the same bytes either way.
export const CUSTODY_GENERATORS = Object.freeze([
  Object.freeze({
    name: "check-limits",
    exports: ["parseArgs", "runLimitsTool", "prepareLimitsTool", "parseLimitsYamlSubset"],
    parse: (module, argv) => module.parseArgs(argv),
    prepare: (module) => module.prepareLimitsTool({ parseYaml: module.parseLimitsYamlSubset }),
    run: (module, options, prepared) => module.runLimitsTool(options, prepared),
  }),
  Object.freeze({
    name: "check-env-admission",
    exports: [
      "parseEnvAdmissionArgs",
      "runEnvAdmissionTool",
      "loadEnvAdmission",
      "parseEnvAdmissionYamlSubset",
    ],
    parse: (module, argv) => module.parseEnvAdmissionArgs(argv),
    prepare: (module) =>
      module.loadEnvAdmission(undefined, { parseYaml: module.parseEnvAdmissionYamlSubset }),
    run: (module, options, prepared) => module.runEnvAdmissionTool(options, prepared),
  }),
  Object.freeze({
    name: "check-model-output",
    exports: ["parseArgs", "runModelOutputTool", "prepareModelOutputTool"],
    parse: (module, argv) => module.parseArgs(argv),
    // `parseYaml: null` is that generator's dependency-free parser.
    prepare: (module) => module.prepareModelOutputTool({ parseYaml: null }),
    run: (module, options, prepared) => module.runModelOutputTool(options, prepared),
  }),
]);

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "../../..");

class CustodyRefusal extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
  }
}

function regularFile(path) {
  try {
    // lstat: a symbolic link is not a regular file here, even to a regular target.
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function cannotList(generator, error) {
  return new CustodyRefusal(
    GENERATOR_FAILED,
    `${generator.name} could not load its tracked inputs to list its outputs: ${messageOf(error)}`,
  );
}

/**
 * Attest every generator's outputs under `root`. Resolves with the number of
 * outputs attested when every one is a current regular file; rejects with a
 * CustodyRefusal naming the first problem.
 */
export async function attestGeneratedOutputs(root = repoRoot) {
  const scripts = join(root, "packages/runtime/scripts");
  let attested = 0;
  for (const generator of CUSTODY_GENERATORS) {
    const script = join(scripts, `${generator.name}.mjs`);
    // Handles exactly a generator that is absent or not a regular file; a
    // present but modified generator is the tracked custody's refusal.
    if (!regularFile(script)) {
      throw new CustodyRefusal(STALE, `the reviewed clone has no regular generator ${script}`);
    }
    let module;
    try {
      module = await import(pathToFileURL(script).href);
    } catch (error) {
      throw cannotList(generator, error);
    }
    // A generator without its tools lists nothing, and would attest nothing.
    if (!generator.exports.every((name) => typeof module[name] === "function")) {
      throw new CustodyRefusal(STALE, `${generator.name} listed no outputs`);
    }
    let prepared;
    let listing;
    try {
      prepared = generator.prepare(module);
      listing = await generator.run(
        module,
        generator.parse(module, ["--print-mirror-paths"]),
        prepared,
      );
    } catch (error) {
      throw cannotList(generator, error);
    }
    const paths = Array.isArray(listing?.paths) ? listing.paths.filter((path) => path !== "") : [];
    if (paths.length === 0) {
      throw new CustodyRefusal(STALE, `${generator.name} listed no outputs`);
    }
    for (const path of paths) {
      let stat = null;
      try {
        stat = lstatSync(join(root, path));
      } catch {
        // Absent: refused just below.
      }
      // Handles exactly a symbolic link at an output path, dangling or not: a
      // check would read through it and attest bytes outside the clone.
      if (stat?.isSymbolicLink()) {
        throw new CustodyRefusal(STALE, `generated output ${path} is a symbolic link`);
      }
      if (!stat?.isFile()) {
        throw new CustodyRefusal(
          STALE,
          `generated output ${path} is missing or not a regular file`,
        );
      }
    }
    try {
      await generator.run(module, generator.parse(module, ["--check"]), prepared);
    } catch (error) {
      throw new CustodyRefusal(STALE, `${generator.name} --check failed: ${messageOf(error)}`);
    }
    attested += paths.length;
  }
  return attested;
}

function isMain() {
  // Realpath both sides: `import.meta.url` is symlink-resolved but argv[1] is
  // not, and a mismatch would exit 0 having checked nothing. Falls back to the
  // unresolved path only when the file cannot be stat'd.
  const real = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  const invoked = process.argv[1] ? real(resolve(process.argv[1])) : "";
  return invoked === real(fileURLToPath(import.meta.url));
}

if (isMain()) {
  if (process.argv.length > 2) {
    process.stdout.write(`${GENERATOR_FAILED}\ncheck-generated-custody takes no arguments\n`);
    process.exitCode = 1;
  } else {
    try {
      const attested = await attestGeneratedOutputs();
      process.stdout.write(`attested ${attested} outputs\n`);
    } catch (error) {
      const code = error instanceof CustodyRefusal ? error.code : GENERATOR_FAILED;
      process.stdout.write(`${code}\n${messageOf(error)}\n`);
      process.exitCode = 1;
    }
  }
}
