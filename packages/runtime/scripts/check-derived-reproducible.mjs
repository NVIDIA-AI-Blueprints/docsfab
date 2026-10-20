#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prove that the build-generated products are reproducible: generate them
 * twice, each time in a fresh copy of the canonical inputs with every product
 * output removed, and compare the two generations byte for byte. A file output
 * compares its type and bytes; a tree output compares its whole path set, in both
 * directions, and the type and bytes of every file or symlink in it. A declared
 * file output must be a regular file so a stable link cannot hide changing bytes.
 *
 * The build regenerates these products on every checkout instead of reading a
 * committed copy, so a generator that embeds a clock, a random value, or host
 * state would give each checkout different bytes. Comparing a generation with
 * the checkout's own copy could not catch that once the copy is itself a
 * generation; two independent generations can.
 *
 * Usage: node scripts/check-derived-reproducible.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILD_GENERATED_MIRRORS as ENV_ADMISSION_MIRRORS } from "./check-env-admission.mjs";
import { BUILD_GENERATED_MIRRORS as LIMITS_MIRRORS } from "./check-limits.mjs";
import { BUILD_GENERATED_MIRRORS as MODEL_OUTPUT_MIRRORS } from "./check-model-output.mjs";
import {
  CATALOG_SOURCE_ROOT,
  DERIVED_PRODUCT_BY_ID,
  KNOWLEDGE_CATALOG_SOURCE_ROOT,
  QUALITY_RUNTIME_POLICY_ROOT,
  QUALITY_SOURCE_ROOT,
  QUALITY_SOURCE_ROOTS,
} from "./derived-products.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRepositoryRoot = resolve(runtimeRoot, "../..");

/** A refusal reported with its code instead of a stack. */
export class ReproducibilityRefusal extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ReproducibilityRefusal";
    this.code = code;
  }
}

/** A generated output compared byte for byte. */
export const fileOutput = (path) => Object.freeze({ kind: "file", path });
/** A generated directory compared by its whole path set and every file's bytes. */
export const treeOutput = (path) => Object.freeze({ kind: "tree", path });

/**
 * A derived product whose every output is a whole directory, read from the
 * product graph so the generator and its trees are named once.
 */
export function treeProduct(id, productsById = DERIVED_PRODUCT_BY_ID) {
  const { script, outputs } = productsById[id];
  return Object.freeze({
    script,
    outputs: Object.freeze(
      outputs.map((pattern) => {
        if (!pattern.endsWith("/**/*")) {
          throw new ReproducibilityRefusal(
            "DERIVED_REPRODUCIBILITY_PRODUCT_INVALID",
            `derived product ${id} declares the output ${pattern}, which is not a whole directory (<path>/**/*), so it cannot be compared as a tree.`,
          );
        }
        return treeOutput(pattern.slice(0, -"/**/*".length));
      }),
    ),
  });
}

/**
 * Each generator, in run order, and the outputs it writes. The quality pack
 * binds the skill-crate lock, so the crate generates first.
 */
export const REPRODUCIBLE_PRODUCTS = Object.freeze([
  Object.freeze({
    script: "check-limits.mjs",
    outputs: Object.freeze(LIMITS_MIRRORS.map(fileOutput)),
  }),
  Object.freeze({
    script: "check-env-admission.mjs",
    outputs: Object.freeze(ENV_ADMISSION_MIRRORS.map(fileOutput)),
  }),
  Object.freeze({
    script: "check-model-output.mjs",
    outputs: Object.freeze(MODEL_OUTPUT_MIRRORS.map(fileOutput)),
  }),
  treeProduct("skill-crate"),
  treeProduct("quality-pack"),
]);

/**
 * The canonical inputs and generator code the generators read. None of them
 * is, holds, or sits inside a generated tree: the generations must start from
 * canonical sources only, never from a checkout's staged copy.
 */
export const REPRODUCIBLE_COPY_ROOTS = Object.freeze([
  "config",
  // CI metadata is a canonical limits input; copy only the owner file, not
  // the broader CI tree, into reproducibility fixtures.
  ".gitlab/ci/train-reuse/metadata.mjs",
  CATALOG_SOURCE_ROOT,
  KNOWLEDGE_CATALOG_SOURCE_ROOT,
  // The limits generator checks these generated doc tables and writes a
  // knowledge mirror only when that package is present.
  "docs/reference/status-and-configuration/operational-limits-tables",
  "packages/knowledge/package.json",
  ...QUALITY_SOURCE_ROOTS.map((root) => `${QUALITY_SOURCE_ROOT}/${root}`),
  `${QUALITY_SOURCE_ROOT}/${QUALITY_RUNTIME_POLICY_ROOT}`,
  "packages/runtime/package.json",
  "packages/runtime/scripts",
  "packages/runtime/src",
  // The model-output catalog validates the rule fixtures it names.
  "packages/runtime/test/fixtures/model-output",
  "packages/runtime/workflows",
]);

/**
 * Resolve the declared input roots for one actual checkout. Only a declared
 * optional owner may be omitted, and only when its exact path is genuinely
 * absent. Every other requested root remains strict at copy time.
 */
export function selectReproducibleCopyRoots(
  repositoryRoot,
  {
    candidateRoots = REPRODUCIBLE_COPY_ROOTS,
    optionalOwnerInputs = DERIVED_PRODUCT_BY_ID.limits.optionalOwnerInputs ?? [],
    lstat = lstatSync,
  } = {},
) {
  if (!Array.isArray(candidateRoots) || !Array.isArray(optionalOwnerInputs)) {
    throw new ReproducibilityRefusal(
      "DERIVED_REPRODUCIBILITY_INPUT_INVALID",
      "copy roots and optional owner inputs must be arrays.",
    );
  }
  for (const ownerPath of optionalOwnerInputs) {
    if (!candidateRoots.includes(ownerPath)) {
      throw new ReproducibilityRefusal(
        "DERIVED_REPRODUCIBILITY_INPUT_INVALID",
        `optional owner ${ownerPath} is not a declared copy root.`,
      );
    }
  }
  const optionalOwners = new Set(optionalOwnerInputs);
  const selected = [];
  for (const path of candidateRoots) {
    if (!optionalOwners.has(path)) {
      selected.push(path);
      continue;
    }
    const segments = path.split("/");
    let current = repositoryRoot;
    let absent = false;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]);
      let entry;
      try {
        entry = lstat(current);
      } catch (error) {
        if (error?.code === "ENOENT") {
          absent = true;
          break;
        }
        throw new ReproducibilityRefusal(
          "DERIVED_REPRODUCIBILITY_INPUT_UNSUPPORTED",
          `${path} could not be safely checked (${error?.code ?? "filesystem error"}).`,
        );
      }
      if (entry.isSymbolicLink()) {
        throw new ReproducibilityRefusal(
          "DERIVED_REPRODUCIBILITY_INPUT_UNSUPPORTED",
          `${path} has a symbolic link in its path and cannot be omitted as an absent owner.`,
        );
      }
      if (index < segments.length - 1 && !entry.isDirectory()) {
        throw new ReproducibilityRefusal(
          "DERIVED_REPRODUCIBILITY_INPUT_UNSUPPORTED",
          `${path} has a non-directory ancestor and cannot be omitted as an absent owner.`,
        );
      }
      if (index === segments.length - 1 && !entry.isFile()) {
        throw new ReproducibilityRefusal(
          "DERIVED_REPRODUCIBILITY_INPUT_UNSUPPORTED",
          `${path} exists but is not a regular file.`,
        );
      }
    }
    if (!absent) selected.push(path);
  }
  return Object.freeze(selected);
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Every entry under a generated tree, by repository-relative path. A symbolic
 * link compares by its target text and type, since following it would compare
 * bytes outside the generation; any other non-regular entry refuses rather
 * than being read or left out.
 */
function readTree(copy, path, script, entries) {
  const walk = (relativePath) => {
    for (const entry of readdirSync(join(copy, relativePath), {
      withFileTypes: true,
    })) {
      const child = posix.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        entries.set(child, { kind: "file", bytes: readFileSync(join(copy, child)) });
      } else if (entry.isSymbolicLink()) {
        entries.set(child, {
          kind: "symlink",
          bytes: readlinkSync(join(copy, child), { encoding: "buffer" }),
        });
      } else {
        throw new ReproducibilityRefusal(
          "DERIVED_REPRODUCIBILITY_OUTPUT_UNSUPPORTED",
          `${script} wrote ${child}, which is neither a file, a directory, nor a symbolic link, so its bytes cannot be compared.`,
        );
      }
    }
  };
  const before = entries.size;
  walk(path);
  if (entries.size === before) {
    throw new ReproducibilityRefusal(
      "DERIVED_REPRODUCIBILITY_OUTPUT_MISSING",
      `${script} exited 0 in a fresh copy of the inputs but wrote no file under ${path}/.`,
    );
  }
}

/** One generation in a fresh copy: every output entry's type and bytes, by repository-relative path. */
function generateInCopy(repositoryRoot, products, copyRoots, copy) {
  for (const path of copyRoots) {
    const source = join(repositoryRoot, path);
    if (!existsSync(source)) {
      throw new ReproducibilityRefusal(
        "DERIVED_REPRODUCIBILITY_INPUT_MISSING",
        `${path} is missing from ${repositoryRoot}, so a generation from a copy of the inputs could differ for that reason alone. Run this check from a full checkout.`,
      );
    }
    cpSync(source, join(copy, path), { recursive: true });
  }
  const installed = join(repositoryRoot, "packages/runtime/node_modules");
  if (existsSync(installed)) symlinkSync(installed, join(copy, "packages/runtime/node_modules"));
  for (const { outputs } of products) {
    for (const { path } of outputs) rmSync(join(copy, path), { recursive: true, force: true });
  }
  const entries = new Map();
  for (const { script, outputs } of products) {
    const run = spawnSync(process.execPath, [join(copy, "packages/runtime/scripts", script)], {
      cwd: join(copy, "packages/runtime"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (run.status !== 0) {
      throw new ReproducibilityRefusal(
        "DERIVED_REPRODUCIBILITY_GENERATION_FAILED",
        `${script} exited ${run.status ?? run.signal} in a fresh copy of the inputs: ${`${run.stderr}`.trim() || run.error?.message || "no output"}.`,
      );
    }
    for (const { kind, path } of outputs) {
      const absolute = join(copy, path);
      // Undefined only when nothing is there; any other stat failure throws.
      const written = lstatSync(absolute, { throwIfNoEntry: false });
      if (written === undefined || (kind === "tree" && !written.isDirectory())) {
        throw new ReproducibilityRefusal(
          "DERIVED_REPRODUCIBILITY_OUTPUT_MISSING",
          `${script} exited 0 in a fresh copy of the inputs but did not write ${kind === "tree" ? `the directory ${path}/` : path}.`,
        );
      }
      if (kind === "file" && !written.isFile()) {
        throw new ReproducibilityRefusal(
          "DERIVED_REPRODUCIBILITY_OUTPUT_UNSUPPORTED",
          `${script} wrote ${path} as ${written.isSymbolicLink() ? "a symbolic link" : "a non-regular file-system entry"}, but a declared file output must be a regular file.`,
        );
      }
      if (kind === "tree") readTree(copy, path, script, entries);
      else {
        entries.set(path, { kind: "file", bytes: readFileSync(absolute) });
      }
    }
  }
  return entries;
}

const describeEntry = (entry) =>
  entry === undefined ? "absent" : `${entry.kind}:${digest(entry.bytes)}`;

/**
 * Generate twice from fresh copies and compare. Returns the compared file
 * paths, sorted; refuses with every path whose two generations differ,
 * including a path only one generation wrote.
 */
export function checkDerivedReproducible(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const products = options.products ?? REPRODUCIBLE_PRODUCTS;
  const copyRoots = Object.hasOwn(options, "copyRoots")
    ? options.copyRoots
    : selectReproducibleCopyRoots(repositoryRoot);
  if (!Array.isArray(copyRoots)) {
    throw new ReproducibilityRefusal(
      "DERIVED_REPRODUCIBILITY_INPUT_INVALID",
      "explicit copyRoots must be an array.",
    );
  }
  const copies = [];
  try {
    const generations = [];
    for (const _ of [0, 1]) {
      const copy = mkdtempSync(join(tmpdir(), "docsfab-reproducible-"));
      copies.push(copy);
      mkdirSync(join(copy, "packages/runtime"), { recursive: true });
      generations.push(generateInCopy(repositoryRoot, products, copyRoots, copy));
    }
    const [first, second] = generations;
    const paths = [...new Set([...first.keys(), ...second.keys()])].sort();
    const differing = paths.filter((path) => {
      const left = first.get(path);
      const right = second.get(path);
      return (
        left === undefined ||
        right === undefined ||
        left.kind !== right.kind ||
        !left.bytes.equals(right.bytes)
      );
    });
    if (differing.length > 0) {
      throw new ReproducibilityRefusal(
        "DERIVED_NOT_REPRODUCIBLE",
        `two generations from clean copies of the same inputs differ: ${differing
          .map(
            (path) =>
              `${path} (${describeEntry(first.get(path))} then ${describeEntry(second.get(path))})`,
          )
          .join(
            ", ",
          )}. A build-generated product must depend only on its inputs; remove the clock, random, or host-specific value from its generator.`,
      );
    }
    return paths;
  } finally {
    for (const copy of copies) rmSync(copy, { recursive: true, force: true });
  }
}

// Realpath both sides: `import.meta.url` is symlink-resolved but argv[1] is
// not, and a mismatch would exit 0 having checked nothing.
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    if (process.argv.length > 2) {
      throw new ReproducibilityRefusal(
        "DERIVED_REPRODUCIBILITY_ARGUMENTS_INVALID",
        `this check takes no arguments, got: ${process.argv.slice(2).join(" ")}.`,
      );
    }
    const paths = checkDerivedReproducible();
    const outputs = REPRODUCIBLE_PRODUCTS.flatMap((product) =>
      product.outputs.map(({ kind, path }) => (kind === "tree" ? `${path}/` : path)),
    );
    console.log(
      `Build-generated products are reproducible: two generations from clean copies are byte-identical (${paths.length} files: ${outputs.join(", ")})`,
    );
  } catch (error) {
    // Handles exactly this check's refusals; any other error keeps its stack.
    if (!(error instanceof ReproducibilityRefusal)) throw error;
    console.error(`check:reproducible: ${error.message}`);
    process.exitCode = 1;
  }
}
