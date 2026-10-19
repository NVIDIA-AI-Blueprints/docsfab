// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { afterEach, describe, it } = testApi;
import {
  BUILD_GENERATED_MIRRORS as LIMITS_MIRRORS,
  loadLimitDefinitions,
} from "./check-limits.mjs";
import {
  REPRODUCIBLE_COPY_ROOTS,
  REPRODUCIBLE_PRODUCTS,
  ReproducibilityRefusal,
  checkDerivedReproducible,
  fileOutput,
  selectReproducibleCopyRoots,
  treeOutput,
  treeProduct,
} from "./check-derived-reproducible.mjs";
import { DERIVED_PRODUCT_BY_ID } from "./derived-products.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

// Two full generations from copied inputs outlast the local per-case default.
const GENERATING_CASE = Object.freeze({
  timeout: loadLimitDefinitions().find((entry) => entry.name === "test.ciTimeoutMs").value,
});
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository root whose one generator writes `body` to out/mirror.txt. */
function generatorRoot(body) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-reproducible-fixture-"));
  roots.push(root);
  mkdirSync(join(root, "packages/runtime/scripts"), { recursive: true });
  writeFileSync(
    join(root, "packages/runtime/scripts/generate.mjs"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const output = new URL("../../../out/mirror.txt", import.meta.url);
mkdirSync(new URL(".", output), { recursive: true });
writeFileSync(output, ${body});
`,
  );
  return {
    repositoryRoot: root,
    products: [{ script: "generate.mjs", outputs: [fileOutput("out/mirror.txt")] }],
    copyRoots: ["packages/runtime/scripts"],
  };
}

/**
 * A repository root whose one generator runs `body` with `tree` bound to the
 * URL of out/tree/ (created) and `marker` to a path outside both copies, so a
 * fixture can make the second generation differ from the first.
 */
function treeGeneratorRoot(body, { output = "out/tree" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-reproducible-tree-"));
  roots.push(root);
  mkdirSync(join(root, "packages/runtime/scripts"), { recursive: true });
  writeFileSync(
    join(root, "packages/runtime/scripts/generate.mjs"),
    `import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const tree = new URL("../../../${output}/", import.meta.url);
const marker = ${JSON.stringify(join(root, "generation-marker"))};
mkdirSync(tree, { recursive: true });
${body}
`,
  );
  return {
    repositoryRoot: root,
    products: [{ script: "generate.mjs", outputs: [treeOutput(output)] }],
    copyRoots: ["packages/runtime/scripts"],
  };
}

/** A full input copy whose shipped file generator writes a changing referent behind a stable symlink. */
function shippedSymlinkFileOutputRoot() {
  const root = mkdtempSync(join(tmpdir(), "docsfab-reproducible-shipped-symlink-"));
  roots.push(root);
  mkdirSync(join(root, "packages/runtime"), { recursive: true });
  for (const path of selectReproducibleCopyRoots(repositoryRoot)) {
    cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  symlinkSync(
    join(repositoryRoot, "packages/runtime/node_modules"),
    join(root, "packages/runtime/node_modules"),
  );
  const marker = join(root, "referent-digests.txt");
  appendFileSync(
    join(root, "packages/runtime/scripts/check-env-admission.mjs"),
    [
      "",
      'if (process.argv[1]?.endsWith("/check-env-admission.mjs")) {',
      '  const fs = await import("node:fs");',
      '  const crypto = await import("node:crypto");',
      '  const output = new URL("./offline-test-env.generated.mjs", import.meta.url);',
      '  const target = new URL("./critic-offline-referent.mjs", import.meta.url);',
      '  const bytes = fs.readFileSync(output, "utf8") + "\\n// nonce " + crypto.randomUUID() + "\\n";',
      "  fs.writeFileSync(target, bytes);",
      "  fs.rmSync(output);",
      '  fs.symlinkSync("critic-offline-referent.mjs", output);',
      `  fs.appendFileSync(${JSON.stringify(marker)}, crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex") + "\\n");`,
      "}",
      "",
    ].join("\n"),
  );
  return { root, marker };
}

/** Every entry under a checkout directory, by repository-relative path. */
function checkoutFiles(path) {
  return readdirSync(join(repositoryRoot, path), { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(repositoryRoot, join(entry.parentPath, entry.name)));
}

function refusal(check) {
  try {
    check();
  } catch (error) {
    assert.ok(error instanceof ReproducibilityRefusal, error.stack);
    return error;
  }
  assert.fail("the check passed");
}

describe("build-generated mirror reproducibility", () => {
  it(
    "passes on the real generators and compares all seven code mirrors and every file of the three trees",
    GENERATING_CASE,
    () => {
      const envMirrors = [
        "packages/runtime/src/config/env-admission.generated.ts",
        "packages/runtime/scripts/offline-test-env.generated.mjs",
      ];
      const modelOutputMirrors = [
        "packages/runtime/src/contracts/model-output.generated.ts",
        "packages/knowledge/src/model-output.generated.mjs",
        "packages/runtime/src/execution/response-contract-vocabulary.generated.json",
      ];
      const mirrors = [...LIMITS_MIRRORS, ...envMirrors, ...modelOutputMirrors];
      const trees = [
        "packages/runtime/skill-crate",
        "packages/runtime/quality",
        "packages/runtime/quality-pack",
      ];
      // The checkout's trees are what the build stages; two generations from
      // canonical sources alone must produce exactly that path set.
      const staged = trees.flatMap(checkoutFiles);
      for (const tree of trees) {
        assert.ok(
          staged.some((path) => path.startsWith(`${tree}/`)),
          `${tree} is empty in the checkout`,
        );
      }
      assert.deepEqual(checkDerivedReproducible(), [...mirrors, ...staged].sort());
      assert.deepEqual(
        REPRODUCIBLE_PRODUCTS.map((product) => [
          product.script,
          product.outputs.map(({ kind, path }) => `${kind}:${path}`),
        ]),
        [
          ["check-limits.mjs", LIMITS_MIRRORS.map((path) => `file:${path}`)],
          ["check-env-admission.mjs", envMirrors.map((path) => `file:${path}`)],
          ["check-model-output.mjs", modelOutputMirrors.map((path) => `file:${path}`)],
          ["generate-catalog-crate.mjs", ["tree:packages/runtime/skill-crate"]],
          [
            "generate-quality-pack.mjs",
            ["tree:packages/runtime/quality", "tree:packages/runtime/quality-pack"],
          ],
        ],
      );
    },
  );

  it("passes on a deterministic generator", () => {
    assert.deepEqual(checkDerivedReproducible(generatorRoot('"same bytes\\n"')), [
      "out/mirror.txt",
    ]);
  });

  it("refuses symlinks at declared file outputs in either generation", () => {
    for (const regularBytes of ["content", "target"]) {
      for (const linkIn of ["first", "second", "both"]) {
        const fixture = generatorRoot('"unused"');
        writeFileSync(
          join(fixture.repositoryRoot, "packages/runtime/scripts/generate.mjs"),
          `import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
const output = new URL("../../../out/mirror.txt", import.meta.url);
const marker = ${JSON.stringify(join(fixture.repositoryRoot, "generation-marker"))};
mkdirSync(new URL(".", output), { recursive: true });
writeFileSync(new URL("../../../out/target", import.meta.url), "content");
const second = existsSync(marker);
writeFileSync(marker, "");
if (${linkIn === "both"} || second === ${linkIn === "second"}) symlinkSync("target", output);
else writeFileSync(output, ${JSON.stringify(regularBytes)});
`,
        );
        const error = refusal(() => checkDerivedReproducible(fixture));
        assert.equal(error.code, "DERIVED_REPRODUCIBILITY_OUTPUT_UNSUPPORTED");
        assert.match(
          error.message,
          /^DERIVED_REPRODUCIBILITY_OUTPUT_UNSUPPORTED: generate\.mjs wrote out\/mirror\.txt as a symbolic link, but a declared file output must be a regular file\./u,
        );
      }
    }
  });

  it("refuses a generator that embeds a nonce, naming the mirror and both digests", () => {
    const error = refusal(() =>
      checkDerivedReproducible(generatorRoot("`nonce ${randomUUID()}\\n`")),
    );
    assert.equal(error.code, "DERIVED_NOT_REPRODUCIBLE");
    assert.match(
      error.message,
      /^DERIVED_NOT_REPRODUCIBLE: two generations from clean copies of the same inputs differ: out\/mirror\.txt \(file:[0-9a-f]{64} then file:[0-9a-f]{64}\)\. /u,
    );
  });

  it("refuses a generator that fails or writes nothing, and a missing input", () => {
    const failing = generatorRoot('"x"');
    writeFileSync(
      join(failing.repositoryRoot, "packages/runtime/scripts/generate.mjs"),
      'console.error("fixture generator failed"); process.exitCode = 4;\n',
    );
    const failed = refusal(() => checkDerivedReproducible(failing));
    assert.equal(
      failed.message,
      "DERIVED_REPRODUCIBILITY_GENERATION_FAILED: generate.mjs exited 4 in a fresh copy of the inputs: fixture generator failed.",
    );

    const silent = generatorRoot('"x"');
    writeFileSync(join(silent.repositoryRoot, "packages/runtime/scripts/generate.mjs"), "");
    assert.equal(
      refusal(() => checkDerivedReproducible(silent)).message,
      "DERIVED_REPRODUCIBILITY_OUTPUT_MISSING: generate.mjs exited 0 in a fresh copy of the inputs but did not write out/mirror.txt.",
    );

    const partial = generatorRoot('"x"');
    assert.equal(
      refusal(() => checkDerivedReproducible({ ...partial, copyRoots: ["config"] })).code,
      "DERIVED_REPRODUCIBILITY_INPUT_MISSING",
    );
  });

  it("removes a stale mirror from each copy before generating", () => {
    const fixture = generatorRoot('"x"');
    // A copied mirror the generator then fails to rewrite must not pass as its output.
    mkdirSync(join(fixture.repositoryRoot, "packages/runtime/scripts/out"), { recursive: true });
    writeFileSync(join(fixture.repositoryRoot, "packages/runtime/scripts/generate.mjs"), "");
    writeFileSync(join(fixture.repositoryRoot, "packages/runtime/scripts/out/mirror.txt"), "old\n");
    const copied = {
      ...fixture,
      products: [
        {
          script: "generate.mjs",
          outputs: [fileOutput("packages/runtime/scripts/out/mirror.txt")],
        },
      ],
    };
    assert.equal(
      refusal(() => checkDerivedReproducible(copied)).code,
      "DERIVED_REPRODUCIBILITY_OUTPUT_MISSING",
    );
  });

  it("passes on a deterministic tree generator and compares every file in the tree", () => {
    const fixture = treeGeneratorRoot(`
mkdirSync(new URL("nested/", tree), { recursive: true });
writeFileSync(new URL("a.txt", tree), "a\\n");
writeFileSync(new URL("nested/b.txt", tree), "b\\n");
symlinkSync("a.txt", new URL("link", tree));
`);
    assert.deepEqual(checkDerivedReproducible(fixture), [
      "out/tree/a.txt",
      "out/tree/link",
      "out/tree/nested/b.txt",
    ]);
  });

  it("refuses a tree generator that embeds a nonce in one file, naming that file", () => {
    const fixture = treeGeneratorRoot(`
writeFileSync(new URL("same.txt", tree), "same\\n");
writeFileSync(new URL("lock.json", tree), \`{"nonce":"\${randomUUID()}"}\\n\`);
`);
    const error = refusal(() => checkDerivedReproducible(fixture));
    assert.equal(error.code, "DERIVED_NOT_REPRODUCIBLE");
    assert.match(
      error.message,
      /^DERIVED_NOT_REPRODUCIBLE: two generations from clean copies of the same inputs differ: out\/tree\/lock\.json \(file:[0-9a-f]{64} then file:[0-9a-f]{64}\)\. A build-generated product must depend only on its inputs; /u,
    );
  });

  it("refuses a symbolic link whose target differs between generations", () => {
    const fixture = treeGeneratorRoot(`symlinkSync(randomUUID(), new URL("link", tree));`);
    assert.match(
      refusal(() => checkDerivedReproducible(fixture)).message,
      /^DERIVED_NOT_REPRODUCIBLE: two generations from clean copies of the same inputs differ: out\/tree\/link \(symlink:[0-9a-f]{64} then symlink:[0-9a-f]{64}\)\. /u,
    );
  });

  it("refuses file and symlink type changes when their raw or encoded bytes match", () => {
    for (const regularBytes of ["symlink:target", "target"]) {
      for (const linkIn of ["first", "second"]) {
        const fixture = treeGeneratorRoot(`
writeFileSync(new URL("target", tree), "content");
const second = existsSync(marker);
writeFileSync(marker, "");
if (second === ${linkIn === "second"}) symlinkSync("target", new URL("entry", tree));
else writeFileSync(new URL("entry", tree), ${JSON.stringify(regularBytes)});
`);
        const error = refusal(() => checkDerivedReproducible(fixture));
        assert.equal(error.code, "DERIVED_NOT_REPRODUCIBLE");
        assert.match(
          error.message,
          linkIn === "first"
            ? /out\/tree\/entry \(symlink:[0-9a-f]{64} then file:[0-9a-f]{64}\)/u
            : /out\/tree\/entry \(file:[0-9a-f]{64} then symlink:[0-9a-f]{64}\)/u,
        );
        assert.doesNotMatch(error.message, /out\/tree\/target \(/u);
      }
    }
  });

  it("accepts matching files and matching symlinks alongside one another", () => {
    const fixture = treeGeneratorRoot(`
writeFileSync(new URL("target", tree), "content");
writeFileSync(new URL("entry", tree), "symlink:target");
symlinkSync("target", new URL("link", tree));
`);
    assert.deepEqual(checkDerivedReproducible(fixture), [
      "out/tree/entry",
      "out/tree/link",
      "out/tree/target",
    ]);
  });

  it("refuses a nonce-named extra file, which each generation writes under its own name", () => {
    const fixture = treeGeneratorRoot(`
writeFileSync(new URL("same.txt", tree), "same\\n");
writeFileSync(new URL(\`\${randomUUID()}.txt\`, tree), "extra\\n");
`);
    const error = refusal(() => checkDerivedReproducible(fixture));
    assert.equal(error.code, "DERIVED_NOT_REPRODUCIBLE");
    const named = [
      ...error.message.matchAll(
        /out\/tree\/([0-9a-f-]{36})\.txt \((absent|file:[0-9a-f]{64}) then (absent|file:[0-9a-f]{64})\)/gu,
      ),
    ];
    // One name per generation, each absent from the other.
    assert.equal(named.length, 2, error.message);
    assert.deepEqual(named.map((match) => [match[2] === "absent", match[3] === "absent"]).sort(), [
      [false, true],
      [true, false],
    ]);
    assert.doesNotMatch(error.message, /same\.txt/u);
  });

  it("refuses a file only the second generation writes, and one only the first writes", () => {
    for (const [extraIn, expected] of [
      ["second", /: out\/tree\/extra\.txt \(absent then file:[0-9a-f]{64}\)\. A build-generated/u],
      ["first", /: out\/tree\/extra\.txt \(file:[0-9a-f]{64} then absent\)\. A build-generated/u],
    ]) {
      const fixture = treeGeneratorRoot(`
writeFileSync(new URL("same.txt", tree), "same\\n");
const second = existsSync(marker);
writeFileSync(marker, "");
if (second === ${extraIn === "second"}) writeFileSync(new URL("extra.txt", tree), "extra\\n");
`);
      const error = refusal(() => checkDerivedReproducible(fixture));
      assert.equal(error.code, "DERIVED_NOT_REPRODUCIBLE");
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /same\.txt/u);
    }
  });

  it("refuses a tree output that is missing, empty, a file, or holds an entry it cannot read", () => {
    const missing = treeGeneratorRoot("", { output: "out/tree" });
    writeFileSync(join(missing.repositoryRoot, "packages/runtime/scripts/generate.mjs"), "");
    assert.equal(
      refusal(() => checkDerivedReproducible(missing)).message,
      "DERIVED_REPRODUCIBILITY_OUTPUT_MISSING: generate.mjs exited 0 in a fresh copy of the inputs but did not write the directory out/tree/.",
    );

    assert.equal(
      refusal(() => checkDerivedReproducible(treeGeneratorRoot(""))).message,
      "DERIVED_REPRODUCIBILITY_OUTPUT_MISSING: generate.mjs exited 0 in a fresh copy of the inputs but wrote no file under out/tree/.",
    );

    // The adjacent case to "nothing written": something written, of the wrong kind.
    const asFile = treeGeneratorRoot("", { output: "out/tree" });
    writeFileSync(
      join(asFile.repositoryRoot, "packages/runtime/scripts/generate.mjs"),
      `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(new URL("../../../out/", import.meta.url), { recursive: true });
writeFileSync(new URL("../../../out/tree", import.meta.url), "not a directory\\n");
`,
    );
    assert.equal(
      refusal(() => checkDerivedReproducible(asFile)).message,
      "DERIVED_REPRODUCIBILITY_OUTPUT_MISSING: generate.mjs exited 0 in a fresh copy of the inputs but did not write the directory out/tree/.",
    );

    const fifo = treeGeneratorRoot(
      `const made = spawnSync("mkfifo", [new URL("pipe", tree).pathname]);
if (made.status !== 0) process.exit(9);`,
    );
    assert.equal(
      refusal(() => checkDerivedReproducible(fifo)).message,
      "DERIVED_REPRODUCIBILITY_OUTPUT_UNSUPPORTED: generate.mjs wrote out/tree/pipe, which is neither a file, a directory, nor a symbolic link, so its bytes cannot be compared.",
    );
  });

  it("removes a stale generated tree from each copy before generating", () => {
    // The tree sits under a copied root, so only the removal keeps the
    // checkout's stale file out of both generations.
    const fixture = treeGeneratorRoot(`writeFileSync(new URL("fresh.txt", tree), "fresh\\n");`, {
      output: "packages/runtime/scripts/out/tree",
    });
    mkdirSync(join(fixture.repositoryRoot, "packages/runtime/scripts/out/tree"), {
      recursive: true,
    });
    writeFileSync(
      join(fixture.repositoryRoot, "packages/runtime/scripts/out/tree/stale.txt"),
      "stale\n",
    );
    assert.deepEqual(checkDerivedReproducible(fixture), [
      "packages/runtime/scripts/out/tree/fresh.txt",
    ]);
  });

  it("copies every canonical input for limits and tree products, and no generated tree", () => {
    const covered = (path) =>
      REPRODUCIBLE_COPY_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
    for (const id of ["limits", "skill-crate", "quality-pack"]) {
      for (const input of DERIVED_PRODUCT_BY_ID[id].inputs) {
        if ((DERIVED_PRODUCT_BY_ID[id].optionalOwnerInputs ?? []).includes(input)) continue;
        assert.ok(covered(input.replace(/\/\*\*\/\*$/u, "")), `${id} input ${input} is not copied`);
      }
    }
    assert.deepEqual(DERIVED_PRODUCT_BY_ID.limits.optionalOwnerInputs, [
      ".gitlab/ci/train-reuse/metadata.mjs",
    ]);
    assert.ok(
      DERIVED_PRODUCT_BY_ID.limits.inputs.includes(
        DERIVED_PRODUCT_BY_ID.limits.optionalOwnerInputs[0],
      ),
      "the optional owner must remain a declared limits input",
    );
    assert.ok(
      REPRODUCIBLE_COPY_ROOTS.includes(DERIVED_PRODUCT_BY_ID.limits.optionalOwnerInputs[0]),
      "the optional owner remains a canonical candidate root",
    );
    assert.ok(
      covered("packages/knowledge/package.json"),
      "limits output owner package is not copied",
    );
    const trees = REPRODUCIBLE_PRODUCTS.flatMap((product) => product.outputs)
      .filter((output) => output.kind === "tree")
      .map((output) => output.path);
    assert.equal(trees.length, 3);
    for (const root of REPRODUCIBLE_COPY_ROOTS) {
      for (const tree of trees) {
        assert.ok(
          root !== tree && !root.startsWith(`${tree}/`) && !tree.startsWith(`${root}/`),
          `copy root ${root} overlaps the generated tree ${tree}`,
        );
      }
    }
  });

  it("selects the optional owner from the actual root, while explicit roots stay strict", () => {
    const absent = generatorRoot('"ok\\n"');
    const owner = ".gitlab/ci/train-reuse/metadata.mjs";
    const present = generatorRoot('"ok\\n"');
    mkdirSync(join(present.repositoryRoot, ".gitlab/ci/train-reuse"), { recursive: true });
    writeFileSync(join(present.repositoryRoot, owner), "export default {};\\n");

    assert.equal(selectReproducibleCopyRoots(absent.repositoryRoot).includes(owner), false);
    assert.equal(selectReproducibleCopyRoots(present.repositoryRoot).includes(owner), true);

    const strict = refusal(() =>
      checkDerivedReproducible({
        ...absent,
        copyRoots: [...absent.copyRoots, owner],
      }),
    );
    assert.equal(strict.code, "DERIVED_REPRODUCIBILITY_INPUT_MISSING");
  });

  it("copies a present optional owner and omits only that owner when absent", () => {
    const owner = ".gitlab/ci/train-reuse/metadata.mjs";
    for (const [ownerBytes, expected] of [
      ["export default 'present';\n", "export default 'present';\n"],
      [null, "absent"],
    ]) {
      const root = mkdtempSync(join(tmpdir(), "docsfab-reproducible-owner-copy-"));
      roots.push(root);
      for (const path of REPRODUCIBLE_COPY_ROOTS) {
        if (path === owner) continue;
        const absolute = join(root, path);
        if (path.endsWith(".json") || path.endsWith(".md")) {
          mkdirSync(join(absolute, ".."), { recursive: true });
          writeFileSync(absolute, "{}\n");
        } else {
          mkdirSync(absolute, { recursive: true });
        }
      }
      mkdirSync(join(root, ".gitlab/ci/train-reuse"), { recursive: true });
      if (ownerBytes !== null) writeFileSync(join(root, owner), ownerBytes);
      writeFileSync(
        join(root, "packages/runtime/scripts/generate.mjs"),
        `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const source = new URL("../../../${owner}", import.meta.url);
let observed = "absent";
try { observed = readFileSync(source, "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (observed !== ${JSON.stringify(expected)}) throw new Error("owner copy mismatch");
const output = new URL("../../../out/mirror.txt", import.meta.url);
mkdirSync(new URL(".", output), { recursive: true });
writeFileSync(output, observed);
`,
      );
      assert.deepEqual(
        checkDerivedReproducible({
          repositoryRoot: root,
          products: [{ script: "generate.mjs", outputs: [fileOutput("out/mirror.txt")] }],
        }),
        ["out/mirror.txt"],
      );
    }
  });

  it("refuses when an owner selected once disappears before the second generation", () => {
    const owner = ".gitlab/ci/train-reuse/metadata.mjs";
    const root = mkdtempSync(join(tmpdir(), "docsfab-reproducible-owner-once-"));
    roots.push(root);
    for (const path of REPRODUCIBLE_COPY_ROOTS) {
      if (path === owner) continue;
      const absolute = join(root, path);
      if (path.endsWith(".json") || path.endsWith(".md")) {
        mkdirSync(join(absolute, ".."), { recursive: true });
        writeFileSync(absolute, "{}\n");
      } else {
        mkdirSync(absolute, { recursive: true });
      }
    }
    mkdirSync(join(root, ".gitlab/ci/train-reuse"), { recursive: true });
    writeFileSync(join(root, owner), "owner present at selection time\n");
    writeFileSync(
      join(root, "packages/runtime/scripts/generate.mjs"),
      `import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
const copiedOwner = new URL("../../../${owner}", import.meta.url);
if (existsSync(copiedOwner)) readFileSync(copiedOwner);
rmSync(${JSON.stringify(join(root, owner))}, { force: true });
const output = new URL("../../../out/mirror.txt", import.meta.url);
mkdirSync(new URL(".", output), { recursive: true });
writeFileSync(output, "fixed output\\n");
`,
    );

    const error = refusal(() =>
      checkDerivedReproducible({
        repositoryRoot: root,
        products: [{ script: "generate.mjs", outputs: [fileOutput("out/mirror.txt")] }],
      }),
    );
    assert.equal(error.code, "DERIVED_REPRODUCIBILITY_INPUT_MISSING");
    assert.ok(error.message.includes(owner), error.message);
  });

  it("omits only a genuinely absent owner and refuses links and filesystem errors", () => {
    const owner = ".gitlab/ci/train-reuse/metadata.mjs";
    const absent = generatorRoot('"ok\\n"');
    assert.equal(selectReproducibleCopyRoots(absent.repositoryRoot).includes(owner), false);
    mkdirSync(join(absent.repositoryRoot, ".gitlab/ci/train-reuse"), { recursive: true });

    const linkedLeaf = generatorRoot('"ok\\n"');
    mkdirSync(join(linkedLeaf.repositoryRoot, ".gitlab/ci/train-reuse"), { recursive: true });
    writeFileSync(join(linkedLeaf.repositoryRoot, "target.mjs"), "export default {};\\n");
    symlinkSync("../../../target.mjs", join(linkedLeaf.repositoryRoot, owner));
    assert.equal(
      refusal(() => selectReproducibleCopyRoots(linkedLeaf.repositoryRoot)).code,
      "DERIVED_REPRODUCIBILITY_INPUT_UNSUPPORTED",
    );

    const linkedAncestor = generatorRoot('"ok\\n"');
    mkdirSync(join(linkedAncestor.repositoryRoot, ".gitlab/ci"), { recursive: true });
    symlinkSync(
      join(linkedAncestor.repositoryRoot, "target-directory"),
      join(linkedAncestor.repositoryRoot, ".gitlab/ci/train-reuse"),
    );
    mkdirSync(join(linkedAncestor.repositoryRoot, "target-directory"), { recursive: true });
    assert.equal(
      refusal(() => selectReproducibleCopyRoots(linkedAncestor.repositoryRoot)).code,
      "DERIVED_REPRODUCIBILITY_INPUT_UNSUPPORTED",
    );

    for (const code of ["EACCES", "EPERM", "ENOTDIR"]) {
      const check = (path) => {
        if (path.endsWith("/metadata.mjs")) throw Object.assign(new Error("fixture"), { code });
        return lstatSync(path);
      };
      assert.equal(
        refusal(() => selectReproducibleCopyRoots(absent.repositoryRoot, { lstat: check })).code,
        "DERIVED_REPRODUCIBILITY_INPUT_UNSUPPORTED",
        code,
      );
    }
  });

  it("refuses each missing tree-product input root by name", () => {
    const newRoots = REPRODUCIBLE_COPY_ROOTS.filter(
      (root) =>
        root.startsWith("packages/knowledge/skills") || root.startsWith("packages/quality/"),
    );
    assert.deepEqual(newRoots, [
      "packages/knowledge/skills",
      "packages/quality/checks",
      "packages/quality/formats",
      "packages/quality/profiles",
      "packages/quality/rubrics",
      "packages/quality/schemas",
      "packages/quality/runtime-policy",
    ]);
    for (const absent of newRoots) {
      const root = mkdtempSync(join(tmpdir(), "docsfab-reproducible-inputs-"));
      roots.push(root);
      for (const path of REPRODUCIBLE_COPY_ROOTS) {
        if (path !== absent && path !== ".gitlab/ci/train-reuse/metadata.mjs") {
          mkdirSync(join(root, path), { recursive: true });
        }
      }
      const error = refusal(() => checkDerivedReproducible({ repositoryRoot: root }));
      assert.equal(
        error.message,
        `DERIVED_REPRODUCIBILITY_INPUT_MISSING: ${absent} is missing from ${root}, so a generation from a copy of the inputs could differ for that reason alone. Run this check from a full checkout.`,
      );
    }
  });

  it("reads tree products from the product graph and refuses one that is not a whole directory", () => {
    assert.deepEqual(treeProduct("quality-pack"), {
      script: "generate-quality-pack.mjs",
      outputs: [
        treeOutput("packages/runtime/quality"),
        treeOutput("packages/runtime/quality-pack"),
      ],
    });
    const error = refusal(() =>
      treeProduct("limits", {
        limits: { script: "check-limits.mjs", outputs: ["config/limits.json"] },
      }),
    );
    assert.equal(
      error.message,
      "DERIVED_REPRODUCIBILITY_PRODUCT_INVALID: derived product limits declares the output config/limits.json, which is not a whole directory (<path>/**/*), so it cannot be compared as a tree.",
    );
  });

  it("runs its command line when invoked through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-reproducible-link-"));
    roots.push(root);
    const link = join(root, "check-derived-reproducible-link.mjs");
    symlinkSync(resolve(import.meta.dirname, "check-derived-reproducible.mjs"), link);
    const result = spawnSync(process.execPath, [link, "--extra"], { encoding: "utf8" });
    // An unresolved entry check would skip the command line and exit 0.
    assert.equal(result.status, 1, result.stdout);
    assert.equal(
      result.stderr,
      "check:reproducible: DERIVED_REPRODUCIBILITY_ARGUMENTS_INVALID: this check takes no arguments, got: --extra.\n",
    );
  });

  it(
    "runs two generations from its no-argument command line through a symlink",
    GENERATING_CASE,
    () => {
      const root = mkdtempSync(join(tmpdir(), "docsfab-reproducible-cli-"));
      roots.push(root);
      const link = join(root, "check-derived-reproducible-link.mjs");
      symlinkSync(resolve(import.meta.dirname, "check-derived-reproducible.mjs"), link);
      const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /^Build-generated products are reproducible: two generations from clean copies are byte-identical \(/u,
      );
      const reported = result.stdout.match(/\((\d+) files:/u);
      assert.ok(reported, result.stdout);
      const outputs = REPRODUCIBLE_PRODUCTS.flatMap((product) => product.outputs);
      const expectedCount =
        outputs.filter((output) => output.kind === "file").length +
        outputs
          .filter((output) => output.kind === "tree")
          .flatMap(({ path }) => checkoutFiles(path)).length;
      assert.equal(Number(reported[1]), expectedCount);
      assert.match(result.stdout, /packages\/runtime\/skill-crate\//u);
      assert.match(result.stdout, /packages\/runtime\/quality\//u);
      assert.match(result.stdout, /packages\/runtime\/quality-pack\//u);
    },
  );

  it(
    "refuses a changing referent behind a symlink at a shipped file output through the real checker command",
    GENERATING_CASE,
    () => {
      const fixture = shippedSymlinkFileOutputRoot();
      const result = spawnSync(
        process.execPath,
        [join(fixture.root, "packages/runtime/scripts/check-derived-reproducible.mjs")],
        {
          cwd: fixture.root,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /DERIVED_REPRODUCIBILITY_OUTPUT_UNSUPPORTED: check-env-admission\.mjs wrote packages\/runtime\/scripts\/offline-test-env\.generated\.mjs as a symbolic link, but a declared file output must be a regular file\./u,
      );
      const referentDigests = readFileSync(fixture.marker, "utf8").trim().split("\n");
      assert.equal(referentDigests.length, 1);
      assert.match(referentDigests[0], /^[0-9a-f]{64}$/u);
    },
  );
});
