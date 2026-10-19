// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { afterEach, describe, it } = testApi;

import { BUILD_GENERATED_MIRRORS } from "./check-limits.mjs";
import { PRIVATE_CONTENT_PATHS } from "../src/config/private-content-paths.js";
import { DERIVED_PRODUCT_BY_ID } from "./derived-products.mjs";
import {
  committedOnlySkips,
  DERIVED_STEPS,
  MACHINE_DERIVED_STEPS,
  MACHINE_DERIVED_TARGETS,
  parseArgs,
  renderJunit,
  runDerived,
  stepArguments,
} from "./generate-derived.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runtime derived-state coordinator", () => {
  it("declares full and machine products in explicit dependency order", () => {
    assert.deepEqual(
      DERIVED_STEPS.map((step) => step.id),
      [
        "limits",
        "env-admission",
        "model-output",
        "skill-crate",
        "quality-pack",
        ...(PRIVATE_CONTENT_PATHS.modelComparisonSource ? ["model-comparison-kit"] : []),
        "model-compositions",
        "composition-digests",
      ],
    );
    assert.deepEqual(
      MACHINE_DERIVED_STEPS.map((step) => step.id),
      [
        "skill-crate",
        "quality-pack",
        "limits",
        "env-admission",
        "model-output",
        "model-compositions",
        "composition-digests",
      ],
    );
    assert.equal(
      MACHINE_DERIVED_STEPS.some((step) => step.id === "model-comparison-kit"),
      false,
    );
    assert.deepEqual(MACHINE_DERIVED_TARGETS, [
      "skill-crate",
      "quality",
      "quality-pack",
      "governed-assets/lock.json",
      "src/config/limits.generated.ts",
      "src/config/env-admission.generated.ts",
      "scripts/offline-test-env.generated.mjs",
      "src/contracts/model-output.generated.ts",
      "src/execution/response-contract-vocabulary.generated.json",
      "docs/reference/contracts/model-output-rules.md",
    ]);
  });

  it("runs its command line when invoked through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-derived-link-"));
    temporaryRoots.push(root);
    const link = join(root, "generate-derived-link.mjs");
    await symlink(resolve(import.meta.dirname, "generate-derived.mjs"), link);
    const result = spawnSync(process.execPath, [link, "--no-such-flag"], { encoding: "utf8" });
    // An unresolved entry check would skip main() and exit 0 having done nothing.
    assert.equal(result.status, 2, result.stderr);
    assert.match(
      result.stderr,
      /^Derived-state argument error: Unknown argument: --no-such-flag$/mu,
    );
  });

  it("parses scope, check mode, and machine-readable report destinations", () => {
    assert.deepEqual(
      parseArgs([
        "--machine",
        "--check",
        "--report-json",
        "/tmp/derived.json",
        "--report-junit",
        "/tmp/derived.xml",
      ]),
      {
        checkOnly: true,
        scope: "machine",
        reportJson: "/tmp/derived.json",
        reportJunit: "/tmp/derived.xml",
      },
    );
    assert.deepEqual(parseArgs(["--report-json=./derived.json", "--report-junit=./derived.xml"]), {
      checkOnly: false,
      scope: "full",
      reportJson: resolve("./derived.json"),
      reportJunit: resolve("./derived.xml"),
    });
  });

  it("checks committed outputs only where a caller asks for that, and every output for the build's own staleness test", () => {
    const limits = DERIVED_STEPS.find((step) => step.id === "limits");
    const envAdmission = DERIVED_STEPS.find((step) => step.id === "env-admission");
    const modelOutput = DERIVED_STEPS.find((step) => step.id === "model-output");
    const compositions = DERIVED_STEPS.find((step) => step.id === "model-compositions");
    assert.deepEqual(stepArguments(limits, true, "committed"), ["--check", "--committed-only"]);
    assert.deepEqual(stepArguments(envAdmission, true, "committed"), [
      "--check",
      "--committed-only",
    ]);
    assert.deepEqual(stepArguments(modelOutput, true, "committed"), [
      "--check",
      "--committed-only",
    ]);
    // The adjacent mode: the build's staleness test checks the untracked mirrors too.
    assert.deepEqual(stepArguments(limits, true, "all"), ["--check"]);
    assert.deepEqual(stepArguments(envAdmission, true, "all"), ["--check"]);
    assert.deepEqual(stepArguments(modelOutput, true, "all"), ["--check"]);
    assert.deepEqual(stepArguments(limits, false, "committed"), []);
    assert.deepEqual(stepArguments(compositions, true, "committed"), []);
    assert.deepEqual(
      DERIVED_PRODUCT_BY_ID.limits.committedCheckArguments,
      limits.committedCheckArguments,
    );
    assert.deepEqual(
      DERIVED_PRODUCT_BY_ID["env-admission"].committedCheckArguments,
      envAdmission.committedCheckArguments,
    );
    assert.deepEqual(
      DERIVED_PRODUCT_BY_ID["model-output"].committedCheckArguments,
      modelOutput.committedCheckArguments,
    );
  });

  it("refuses a check that does not name which outputs it reads", async () => {
    for (const checkOutputs of [undefined, "some"]) {
      await assert.rejects(
        runDerived({
          checkOnly: true,
          checkOutputs,
          steps: [],
          executeStep: async () => assert.fail(),
        }),
        {
          message: `a derived-state check needs checkOutputs committed or all, got ${checkOutputs}`,
        },
      );
    }
    // Generation reads no outputs, so it names none.
    const generated = await runDerived({
      steps: [],
      targets: [],
      executeStep: async () => assert.fail(),
    });
    assert.equal(generated.status, "passed");
  });

  it("passes the caller's output set to every step", async () => {
    const seen = [];
    await runDerived({
      checkOnly: true,
      checkOutputs: "committed",
      steps: [{ id: "a" }, { id: "b" }],
      executeStep: async (step, checkOnly, checkOutputs) => {
        seen.push([step.id, checkOnly, checkOutputs]);
        return { id: step.id, status: "passed", durationMs: 0 };
      },
    });
    assert.deepEqual(seen, [
      ["a", true, "committed"],
      ["b", true, "committed"],
    ]);
  });

  it("reads only the committed-only skip lines from a generator's output", () => {
    const lines = BUILD_GENERATED_MIRRORS.map(
      (path) => `${path}: not checked here, the build generates it (scripts/ensure-derived.mjs)`,
    );
    assert.deepEqual(
      committedOnlySkips(
        [
          "example.generated.txt: skipped, its owner example is absent from this tree",
          ...lines,
          "Limits configuration is current (1 entries)",
          "",
        ].join("\n"),
      ),
      lines,
    );
  });

  it("the shipped check:pins reads committed outputs only, writes only the untracked mirrors, and names them", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "generate-derived.mjs"), "--machine", "--check"],
      { encoding: "utf8", cwd: resolve(import.meta.dirname, "..") },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lines = result.stdout.split("\n");
    assert.ok(lines.includes("PASS model-compositions"), result.stdout);
    for (const path of BUILD_GENERATED_MIRRORS) {
      assert.ok(
        lines.includes(
          `  ${path}: not checked here, the build generates it (scripts/ensure-derived.mjs)`,
        ),
        result.stdout,
      );
    }
  });

  it("fails a source-importing step whose mirrors cannot be written, and runs a plain step in the same tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-derived-source-step-"));
    temporaryRoots.push(root);
    const repository = resolve(import.meta.dirname, "../../..");
    for (const path of [
      "config",
      "packages/runtime/scripts",
      "packages/runtime/src/config",
      "packages/runtime/src/skills",
    ]) {
      await cp(join(repository, path), join(root, path), { recursive: true });
    }
    // The catalog cannot load, so the limits mirrors cannot be rendered.
    await writeFile(join(root, "config/limits.yaml"), "schemaVersion: 2\n");
    await writeFile(
      join(root, "packages/runtime/scripts/plain-step.mjs"),
      "process.exitCode = 0;\n",
    );
    const { runDerived: copiedRunDerived } = await import(
      pathToFileURL(join(root, "packages/runtime/scripts/generate-derived.mjs")).href
    );
    const report = await copiedRunDerived({
      checkOnly: true,
      checkOutputs: "committed",
      steps: [
        { id: "plain", script: "plain-step.mjs", checkArgument: false },
        {
          id: "imports-source",
          script: "plain-step.mjs",
          checkArgument: false,
          importsRuntimeSource: true,
        },
      ],
    });
    assert.deepEqual(
      report.cases.map(({ id, status }) => [id, status]),
      [
        ["plain", "passed"],
        ["imports-source", "failed"],
      ],
    );
    assert.match(
      report.firstFailure.message,
      /^could not write the build-generated mirrors it imports: .*config\/limits\.yaml must declare schemaVersion 1/u,
    );
  });

  it("renders one JUnit case per completed stage and escapes failure output", () => {
    const xml = renderJunit({
      durationMs: 12,
      cases: [
        { id: "skill-crate", status: "passed", durationMs: 4 },
        {
          id: "quality-pack",
          status: "failed",
          durationMs: 8,
          message: "stale <lock> & output",
        },
      ],
    });
    assert.match(xml, /tests="2" failures="1"/u);
    assert.match(xml, /name="skill-crate"/u);
    assert.match(xml, /stale &lt;lock&gt; &amp; output/u);
  });

  it("restores exact generated bytes, modes, and absence after a later failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-derived-rollback-test-"));
    temporaryRoots.push(root);
    const retained = join(root, "skill-crate", "tool.sh");
    const retainedLock = join(root, "governed-assets", "lock.json");
    const newlyCreated = join(root, "quality-pack", "unexpected.json");
    await mkdir(join(root, "skill-crate"), { recursive: true });
    await mkdir(join(root, "governed-assets"), { recursive: true });
    await writeFile(retained, "known-good\n", { mode: 0o755 });
    await writeFile(retainedLock, '{"known":"good"}\n', { mode: 0o644 });

    const steps = [{ id: "mutate" }, { id: "validate" }];
    const report = await runDerived({
      scope: "machine",
      targetRoot: root,
      targets: ["skill-crate", "quality-pack", "governed-assets/lock.json"],
      steps,
      executeStep: async (step) => {
        if (step.id === "mutate") {
          await writeFile(retained, "corrupt\n");
          await chmod(retained, 0o644);
          await writeFile(retainedLock, '{"corrupt":true}\n');
          await mkdir(join(root, "quality-pack"), { recursive: true });
          await writeFile(newlyCreated, "unexpected\n");
          return { id: step.id, status: "passed", durationMs: 1 };
        }
        return {
          id: step.id,
          status: "failed",
          durationMs: 1,
          message: "synthetic later-stage failure",
        };
      },
    });

    assert.equal(report.status, "failed");
    assert.equal(report.firstFailure?.id, "validate");
    assert.equal(await readFile(retained, "utf8"), "known-good\n");
    assert.equal((await stat(retained)).mode & 0o777, 0o755);
    assert.equal(await readFile(retainedLock, "utf8"), '{"known":"good"}\n');
    assert.equal((await stat(retainedLock)).mode & 0o777, 0o644);
    await assert.rejects(access(newlyCreated, constants.F_OK), { code: "ENOENT" });
  });
});
