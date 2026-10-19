// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The limits and env-admission generators write the same bytes with or
 * without an installed runtime package, so the shared generation step runs in
 * a checkout that has never run `npm ci`: host CI jobs, the knowledge package
 * and root-sealed reviewed clones. Biome does not format or lint their
 * outputs, so no canonical edit can leave the generator's check and the
 * package's format check disagreeing.
 */
import { type ExecFileException, execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadEnvAdmission,
  renderTypeScript as renderEnvAdmissionTypeScript,
  runEnvAdmissionTool,
} from "../scripts/check-env-admission.mjs";
import {
  loadLimitDefinitions,
  renderTypeScript as renderLimitsTypeScript,
  runLimitsTool,
} from "../scripts/check-limits.mjs";
import { runModelOutputTool } from "../scripts/check-model-output.mjs";
import { copiedDerivedCheckout } from "./helpers/derived-checkout.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();

// Local per-case budget, declared through testTimeoutMs so CI never drops
// below its shared default: two copied checkouts and two generation runs, or
// one copied checkout, one generation run and three Biome passes over it, or
// two Biome passes over the authored *.generated.* files.
const TWO_CHECKOUTS_TEST_MS = 90_000;
// Each child gets most of the case budget so it fails with its own output first.
const GENERATION_CHILD_MS = 40_000;
// Execution plumbing: room for a child's diagnostics, not a bound under test.
const CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;

const LIMITS_MIRROR = "packages/runtime/src/config/limits.generated.ts";
const ENV_ADMISSION_MIRROR = "packages/runtime/src/config/env-admission.generated.ts";
// The path both removed formatting passes probed.
const BIOME_BIN = "packages/runtime/node_modules/@biomejs/biome/bin/biome";
const STUB_MARKER = "// rewritten by a stub formatter";
// A formatter that changes every file it is given, so any output it reaches differs.
const REWRITING_BIOME = `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(`${STUB_MARKER}\n`)} + input); });
`;

interface Completed {
  readonly code: number | null;
  readonly stderr: string;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("VITEST")) delete environment[key];
  }
  return environment;
}

function runNode(args: readonly string[], cwd: string): Promise<Completed> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      args,
      {
        cwd,
        env: childEnvironment(),
        timeout: GENERATION_CHILD_MS,
        maxBuffer: CHILD_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error: ExecFileException | null, _stdout: string, stderr: string) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolveRun({ code, stderr });
      },
    );
  });
}

/** A copied checkout whose runtime package has no `node_modules` at all. */
async function uninstalledCheckout(): Promise<string> {
  const root = await copiedDerivedCheckout(roots, "docsfab-install-free-");
  await rm(join(root, "packages/runtime/node_modules"));
  return root;
}

/** Delete both code mirrors, then regenerate them through the shipped hook. */
async function regenerate(root: string): Promise<Record<string, string>> {
  for (const path of [LIMITS_MIRROR, ENV_ADMISSION_MIRROR]) await rm(join(root, path));
  const result = await runNode(
    ["scripts/ensure-derived.mjs", "--steps", "limits,env-admission"],
    join(root, "packages/runtime"),
  );
  expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
  return {
    [LIMITS_MIRROR]: await readFile(join(root, LIMITS_MIRROR), "utf8"),
    [ENV_ADMISSION_MIRROR]: await readFile(join(root, ENV_ADMISSION_MIRROR), "utf8"),
  };
}

describe("install-free limits and env-admission generation", () => {
  it(
    "regenerates both deleted code mirrors with no node_modules, and an installed formatter changes nothing",
    async () => {
      const canonicalRoot = await uninstalledCheckout();
      const canonical = await regenerate(canonicalRoot);

      // Positive control: the stub really rewrites what it is given.
      const stubbedRoot = await uninstalledCheckout();
      await mkdir(dirname(join(stubbedRoot, BIOME_BIN)), { recursive: true });
      await writeFile(join(stubbedRoot, BIOME_BIN), REWRITING_BIOME);
      await chmod(join(stubbedRoot, BIOME_BIN), 0o755);
      const probe = spawnSync(process.execPath, [join(stubbedRoot, BIOME_BIN)], {
        input: "x\n",
        encoding: "utf8",
      });
      expect(probe.stdout).toBe(`${STUB_MARKER}\nx\n`);

      const stubbed = await regenerate(stubbedRoot);

      expect(stubbed).toEqual(canonical);
      for (const text of Object.values(stubbed)) expect(text).not.toContain(STUB_MARKER);
      expect(existsSync(join(canonicalRoot, "packages/runtime/node_modules"))).toBe(false);
    },
    testTimeoutMs(TWO_CHECKOUTS_TEST_MS),
  );
});

describe("Biome leaves generated mirrors to their generators", () => {
  const biome = join(runtimeRoot, "node_modules/@biomejs/biome/bin/biome");
  const OFFLINE_MIRROR = "packages/runtime/scripts/offline-test-env.generated.mjs";
  // An authored copy of a generated mirror: the exclusion must not reach it.
  const AUTHORED_COPY = "src/config/authored-copy-of-limits.ts";

  /** Biome's own output for `source` as an authored file, ignoring every exclusion. */
  const authoredFormat = (source: string) =>
    spawnSync(process.execPath, [biome, "format", "--stdin-file-path", "src/authored-probe.ts"], {
      cwd: runtimeRoot,
      input: source,
      encoding: "utf8",
    });

  /** The package's `format:check` (`biome format .`) or `lint` (`biome lint .`). */
  const biomeOver = (runtime: string, command: "format" | "lint") =>
    runNode([biome, command, "."], runtime);

  async function edit(root: string, path: string, change: (text: string) => string) {
    const before = await readFile(join(root, path), "utf8");
    const after = change(before);
    expect(after).not.toBe(before);
    await writeFile(join(root, path), after);
  }

  function replaceOnce(text: string, from: string, to: string): string {
    expect(text.split(from)).toHaveLength(2);
    return text.replace(from, to);
  }

  // Each edit is a shape Biome would rewrite in an authored file: a double-quoted
  // phrase (Biome picks single quotes to escape fewer), a limit name of 88 or more
  // characters (Biome breaks the property line), one-name lists (Biome collapses
  // Object.freeze([...]) onto one line) and an empty list (Biome drops its blank line).
  const CONFIG_PREP_GATE = "          requiresConfigPrepArgv: true\n";
  const LONG_NAME = `artifacts.${"adversarialLongLimitName".repeat(4)}`;
  const LONG_LIMIT = `
  - name: ${LONG_NAME}
    value: 4096
    unit: bytes
    scope: per-run
    warnAt: 0.8
    override: DOCSFAB_ARTIFACTS_ADVERSARIAL_LONG_LIMIT_NAME
    min: 1
    max: 8192
    refusal: artifacts-adversarial-long-limit-name-bound
    remediation: Raise DOCSFAB_ARTIFACTS_ADVERSARIAL_LONG_LIMIT_NAME, then rerun the same "docsfab run" command.
    rationale: A test-only limit whose "name" is long enough that Biome would break its property line.
    docValue: 4,096 bytes
    docSummary: Test-only limit with a long name.
`;

  it(
    "Biome still formats and lints every *.generated.* file that no generator writes",
    async () => {
      const written = new Set<string>();
      for (const listing of [
        await runLimitsTool({ printMirrorPaths: true }),
        await runEnvAdmissionTool({ printMirrorPaths: true }),
        runModelOutputTool({ printMirrorPaths: true }),
      ]) {
        for (const path of listing.paths as string[]) written.add(path);
      }
      // Biome's included roots, walked rather than listed, so a new authored file
      // with the suffix is covered without editing this test.
      const authored: string[] = [];
      for (const top of ["src", "test", "scripts", "bin"]) {
        if (!existsSync(join(runtimeRoot, top))) continue;
        for (const entry of readdirSync(join(runtimeRoot, top), { recursive: true }) as string[]) {
          const path = `${top}/${entry}`;
          if (!/\.generated\./u.test(path) || path.includes("node_modules/")) continue;
          if (!written.has(`packages/runtime/${path}`)) authored.push(path);
        }
      }
      // The hand-authored re-export of the limits mirror keeps the suffix.
      expect(authored).toContain("src/config/limits.generated.js");
      for (const command of ["format", "lint"] as const) {
        const result = await runNode([biome, command, ...authored], runtimeRoot);
        expect({ command, authored, code: result.code, stderr: result.stderr }).toMatchObject({
          command,
          authored,
          code: 0,
        });
      }
    },
    testTimeoutMs(TWO_CHECKOUTS_TEST_MS),
  );

  it(
    "adversarial canonical edits regenerate, pass every generator check and Biome, and an authored copy still fails format",
    async () => {
      const root = await copiedDerivedCheckout(roots, "docsfab-biome-generated-");
      const runtime = join(root, "packages/runtime");
      await writeFile(join(runtime, "biome.json"), await readFile(join(runtimeRoot, "biome.json")));

      await edit(root, "config/limits/artifacts.yaml", (text) =>
        replaceOnce(
          text,
          "then rerun the same command. Stored objects are unchanged.",
          'then rerun the same "docsfab run" command. Stored objects are unchanged.',
        ).replace(/\n*$/, `\n${LONG_LIMIT}`),
      );
      await edit(root, "config/env-admission.yaml", (text) => {
        const purpose = (id: string) => {
          const begin = text.indexOf(`  - id: ${id}\n`);
          const end = text.indexOf("\n  - id: ", begin + 1);
          return text.slice(begin, end === -1 ? text.length : end);
        };
        const admitsOnly = (block: string, names: readonly string[]) => {
          const head = block.slice(0, block.indexOf("    admits:\n"));
          const entries = names.map((name) => `      - name: ${name}\n        kind: forwarded\n`);
          return `${head}    admits:\n${entries.join("")}`;
        };
        expect(text).toContain(CONFIG_PREP_GATE);
        return (
          text
            .replace(purpose("acceptance-local"), admitsOnly(purpose("acceptance-local"), ["PATH"]))
            .replace(purpose("offline-tests"), admitsOnly(purpose("offline-tests"), ["PATH"]))
            // No config-prep entry leaves CI_RUNTIME_RUN_LIVE_MODEL_CONFIG_PREP_NAMES empty.
            .replaceAll(CONFIG_PREP_GATE, "")
        );
      });

      const regenerated = await regenerate(root);
      regenerated[OFFLINE_MIRROR] = await readFile(join(root, OFFLINE_MIRROR), "utf8");
      expect(regenerated[LIMITS_MIRROR]).toContain(JSON.stringify('"docsfab run"').slice(1, -1));
      expect(regenerated[LIMITS_MIRROR]).toContain(LONG_NAME);
      expect(regenerated[ENV_ADMISSION_MIRROR]).toContain(
        "CI_RUNTIME_RUN_LIVE_MODEL_CONFIG_PREP_NAMES: readonly string[] = Object.freeze([\n\n])",
      );

      // Positive control: Biome rewrites every regenerated mirror as an authored file,
      // so each one really is outside Biome's style.
      for (const [path, text] of Object.entries(regenerated)) {
        const formatted = authoredFormat(text);
        expect({ path, status: formatted.status }).toEqual({ path, status: 0 });
        expect({ path, unchanged: formatted.stdout === text }).toEqual({ path, unchanged: false });
      }

      for (const generator of ["check-limits", "check-env-admission"]) {
        const checked = await runNode([`scripts/${generator}.mjs`, "--check"], runtime);
        expect({ generator, code: checked.code, stderr: checked.stderr }).toMatchObject({
          generator,
          code: 0,
        });
      }
      for (const command of ["format", "lint"] as const) {
        const result = await biomeOver(runtime, command);
        expect({ command, code: result.code, stderr: result.stderr }).toMatchObject({
          command,
          code: 0,
        });
      }

      // Adjacent condition: the same bytes in an authored file still fail format.
      await writeFile(join(runtime, AUTHORED_COPY), regenerated[LIMITS_MIRROR]);
      const authored = await biomeOver(runtime, "format");
      expect(authored.code).toBe(1);
      expect(authored.stderr).toContain(AUTHORED_COPY);
    },
    testTimeoutMs(TWO_CHECKOUTS_TEST_MS),
  );
});
