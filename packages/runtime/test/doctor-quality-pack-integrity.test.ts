// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { ArtifactStoreError } from "../src/artifacts/store.js";
import { ContentIndexError } from "../src/content-ir/contracts.js";
import { ContextQueryError } from "../src/context/queries.js";
import { formatDoctorReadiness, inspectDoctorReadiness } from "../src/doctor-readiness.js";
import { ReaderTaskContextError } from "../src/execution/task-context.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import {
  classifyThrownFailure,
  operatorCodeFailureClass,
} from "../src/operator/failure-classification.js";
import { DOCTOR_DIAGNOSTIC_CODES } from "../src/operator/situation-catalog.js";
import { QualityPackError as QualityPackErrorLeaf } from "../src/quality-pack/error.js";
import {
  QualityPackError,
  type QualityPackErrorCode,
  verifyQualityPackContext,
} from "../src/quality-pack/manifest.js";
import { CatalogSkillCrateError } from "../src/skills/catalog-crate.js";
import { GovernedSkillIntegrityError } from "../src/skills/roadmap-pack.js";
import { readyDoctorFixture } from "./helpers/doctor-ready-fixture.js";
import { initFixtureRepo } from "./helpers/git.js";
import { validModelEnvironment } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execFileAsync = promisify(execFile);
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = temporaryRoots();

/**
 * The restore step a source checkout prints, which is where these tests run.
 * Pinned as a literal so the operator-facing text is checked apart from the source.
 */
const SOURCE_CHECKOUT_RESTORE =
  "Regenerate the quality pack from this checkout's sources: from the repository root, run `npm --prefix packages/runtime run build`, then run the command again.";

/** Every code `QualityPackError` can carry; `satisfies` fails when one is added. */
const QUALITY_PACK_CODES = {
  "lock-unavailable": true,
  "migration-required": true,
  "invalid-lock": true,
  "invalid-manifest": true,
  stale: true,
  tampered: true,
  "unsafe-path": true,
  "file-set-mismatch": true,
  "checksum-mismatch": true,
} as const satisfies Record<QualityPackErrorCode, true>;

interface PackCopy {
  readonly root: string;
  readonly qualityDirectory: string;
  readonly qualityPackDirectory: string;
}

/** A private copy of the package's quality files and manifest, safe to tamper with. */
async function packCopy(root: string): Promise<PackCopy> {
  const pack = resolve(root, "pack");
  const copy = {
    root: pack,
    qualityDirectory: resolve(pack, "quality"),
    qualityPackDirectory: resolve(pack, "quality-pack"),
  };
  await mkdir(pack);
  await cp(resolve(runtimeRoot, "quality"), copy.qualityDirectory, { recursive: true });
  await cp(resolve(runtimeRoot, "quality-pack"), copy.qualityPackDirectory, { recursive: true });
  return copy;
}

const RUBRIC = ["rubrics", "task-guide.yaml"] as const;

/** The four tampers QA applied to an installed copy, with the code `run` reports for each. */
const TAMPERS: ReadonlyArray<
  readonly [string, QualityPackErrorCode, (pack: PackCopy) => Promise<void>]
> = [
  [
    "one changed byte in a rubric",
    "checksum-mismatch",
    async (pack) => {
      const path = resolve(pack.qualityDirectory, ...RUBRIC);
      const text = await readFile(path, "utf8");
      const index = text.search(/[a-y]/u);
      await writeFile(
        path,
        `${text.slice(0, index)}${String.fromCharCode(text.charCodeAt(index) + 1)}${text.slice(index + 1)}`,
      );
    },
  ],
  [
    "an extra rubric",
    "file-set-mismatch",
    async (pack) => {
      await cp(
        resolve(pack.qualityDirectory, ...RUBRIC),
        resolve(pack.qualityDirectory, "rubrics", "extra-guide.yaml"),
      );
    },
  ],
  [
    "a rubric replaced by a symbolic link",
    "unsafe-path",
    async (pack) => {
      const path = resolve(pack.qualityDirectory, ...RUBRIC);
      const moved = resolve(pack.root, "task-guide.yaml");
      await rename(path, moved);
      await symlink(moved, path);
    },
  ],
  [
    "a changed manifest digest",
    "stale",
    async (pack) => {
      const path = resolve(pack.qualityPackDirectory, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8")) as { bindingSha256: string };
      const digest = manifest.bindingSha256;
      manifest.bindingSha256 = `${digest.startsWith("0") ? "1" : "0"}${digest.slice(1)}`;
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  ],
];

describe("doctor names a quality-pack integrity failure with the code run reports", () => {
  it.each(TAMPERS)(
    "reports %s as %s with a restore step and no host path",
    { timeout: testTimeoutMs(30_000) },
    async (_tamper, code, tamper) => {
      const fixture = await readyDoctorFixture(roots);
      const pack = await packCopy(fixture.root);
      await tamper(pack);
      const result = await inspectDoctorReadiness({
        ...fixture.options,
        loadConfiguration: () => ({ ...fixture.config, ...pack }),
      });

      expect(result.diagnostics).toContainEqual({
        area: "installation",
        code,
        explanation: new QualityPackError(code).message,
        nextCommand: SOURCE_CHECKOUT_RESTORE,
      });
      expect(result.diagnostics.map((item) => item.code)).not.toContain(
        "provider-runtime-unavailable",
      );
      expect(result.status).toBe("blocked");
      expect(result.checks).toContainEqual({ area: "installation", status: "blocked" });
      for (const output of [
        formatDoctorReadiness(result),
        canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue),
      ]) {
        expect(output).not.toContain(pack.root);
      }
      // The same copy refuses with the same code on the path `run` verifies, and
      // run's envelope gives that refusal a class and the same restore step.
      const refusal = await verifyQualityPackContext({
        ...pack,
        skillCrateDirectory: fixture.config.skillCrateDirectory,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(QualityPackError);
      expect(refusal).toMatchObject({ name: "QualityPackError", code });
      expect(toOperatorErrorEnvelope(refusal)).toMatchObject({
        code,
        nextAction: SOURCE_CHECKOUT_RESTORE,
        failure: { class: "infrastructure", layer: "cli", code },
      });
    },
  );

  it("matches the baseline doctor output once the pack is restored", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await readyDoctorFixture(roots);
    const options = { ...fixture.options, loadConfiguration: () => fixture.config };
    const baseline = await inspectDoctorReadiness(options);
    expect(baseline.status).toBe("ready");

    const pack = await packCopy(fixture.root);
    const copied = { ...options, loadConfiguration: () => ({ ...fixture.config, ...pack }) };
    await TAMPERS[0]![2](pack);
    expect((await inspectDoctorReadiness(copied)).diagnostics.map((item) => item.code)).toContain(
      "checksum-mismatch",
    );

    await rm(pack.qualityDirectory, { recursive: true });
    await cp(resolve(runtimeRoot, "quality"), pack.qualityDirectory, { recursive: true });
    const restored = await inspectDoctorReadiness(copied);
    expect(restored).toEqual(baseline);
    expect(formatDoctorReadiness(restored)).toBe(formatDoctorReadiness(baseline));
  });

  it("maps every QualityPackError code without forwarding the error's message", async () => {
    const fixture = await readyDoctorFixture(roots);
    for (const code of Object.keys(QUALITY_PACK_CODES) as QualityPackErrorCode[]) {
      const result = await inspectDoctorReadiness({
        ...fixture.options,
        loadConfiguration: () => fixture.config,
        validateConfiguration: async () => {
          throw new QualityPackError(code, `${code} at ${fixture.root}/quality/private-file`);
        },
      });
      expect(result.diagnostics, code).toContainEqual({
        area: "installation",
        code,
        explanation: new QualityPackError(code).message,
        nextCommand: SOURCE_CHECKOUT_RESTORE,
      });
      expect(formatDoctorReadiness(result)).not.toContain("private-file");
    }
  });

  it("keeps provider-runtime-unavailable for a genuine provider registration failure", async () => {
    const fixture = await readyDoctorFixture(roots);
    const result = await inspectDoctorReadiness({
      ...fixture.options,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => {
        throw new Error("Policy model registration failed without retaining endpoint diagnostics.");
      },
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ area: "provider", code: "provider-runtime-unavailable" }),
    );
    expect(result.diagnostics.map((item) => item.area)).not.toContain("installation");
  });
});

describe("docsfab run reports a quality-pack integrity failure with a class and next action", () => {
  it("classes the code and names the restore step in the operator envelope", () => {
    const envelope = toOperatorErrorEnvelope(new QualityPackError("checksum-mismatch"));
    expect(envelope).toMatchObject({
      code: "checksum-mismatch",
      message: "Runtime quality file or bundle checksum does not match its lock.",
      nextAction: SOURCE_CHECKOUT_RESTORE,
      failure: { class: "infrastructure", layer: "cli", code: "checksum-mismatch" },
    });
    const human = formatOperatorErrorEnvelope(envelope).split("\n");
    expect(human).toContain("failure class: infrastructure (layer cli)");
    expect(human).toContain(`Next action: ${SOURCE_CHECKOUT_RESTORE}`);
  });

  it("prints the same code and next action from docsfab run and docsfab doctor on one tampered pack", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const root = await roots.create("docsfab-quality-pack-cli-", { realpath: true });
    const repository = resolve(root, "repository");
    const configuration = resolve(root, "configuration");
    await mkdir(configuration, { mode: 0o700 });
    await initFixtureRepo(repository, { "README.md": "# Fixture\n" });
    const pack = await packCopy(root);
    await TAMPERS[0]![2](pack);
    const cli = async (args: readonly string[]) => {
      try {
        const result = await execFileAsync(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", ...args],
          {
            cwd: runtimeRoot,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: root,
              TMPDIR: tmpdir(),
              PI_OFFLINE: "1",
              DOCSFAB_CONFIG_ROOT: configuration,
              DOCSFAB_QUALITY_DIR: pack.qualityDirectory,
              DOCSFAB_QUALITY_PACK_DIR: pack.qualityPackDirectory,
              ...validModelEnvironment,
            },
          },
        );
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          exitCode: typeof failure.code === "number" ? failure.code : -1,
        };
      }
    };

    const run = await cli(["run", "review-documentation", "--repo", repository, "--json"]);
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stderr)).toMatchObject({
      code: "checksum-mismatch",
      message: "Runtime quality file or bundle checksum does not match its lock.",
      nextAction: SOURCE_CHECKOUT_RESTORE,
      failure: { class: "infrastructure", code: "checksum-mismatch" },
    });

    const doctor = await cli(["doctor", "--repo", repository, "--json"]);
    expect(doctor.exitCode).toBe(1);
    expect(JSON.parse(doctor.stdout).diagnostics).toContainEqual({
      area: "installation",
      code: "checksum-mismatch",
      explanation: "Runtime quality file or bundle checksum does not match its lock.",
      nextCommand: SOURCE_CHECKOUT_RESTORE,
    });
    for (const output of [run.stderr, doctor.stdout]) expect(output).not.toContain(pack.root);
  });
});

/** Every code a quality-pack error can carry, in the order the error declares them. */
const PACK_CODES = Object.keys(QUALITY_PACK_CODES) as QualityPackErrorCode[];

/**
 * Other errors that carry a code the pack also uses, each built as its own module
 * throws it. A bare code cannot tell these from a pack failure, so only the type can.
 */
const OTHER_THROWERS: ReadonlyArray<readonly [string, string, () => Error]> = [
  [
    "a content index refusal",
    "unsafe-path",
    () => new ContentIndexError("unsafe-path", "Content index rejects symlink: docs/page.md."),
  ],
  [
    "an artifact store refusal",
    "unsafe-path",
    () => new ArtifactStoreError("unsafe-path", "artifacts/objects/ab"),
  ],
  ["a context query refusal", "unsafe-path", () => new ContextQueryError("unsafe-path", "$.page")],
  ["a reader task context refusal", "stale", () => new ReaderTaskContextError("stale")],
  ...(
    [
      "lock-unavailable",
      "invalid-lock",
      "stale",
      "tampered",
      "unsafe-path",
      "file-set-mismatch",
      "checksum-mismatch",
    ] as const
  ).map(
    (code) =>
      ["a catalog skill crate refusal", code, () => new CatalogSkillCrateError(code)] as const,
  ),
  ...(
    [
      "lock-unavailable",
      "invalid-lock",
      "unsafe-path",
      "file-set-mismatch",
      "checksum-mismatch",
    ] as const
  ).map(
    (code) =>
      [
        "a governed skill integrity refusal",
        code,
        () => new GovernedSkillIntegrityError(code),
      ] as const,
  ),
];

describe("a quality-pack code is classed by the error that carries it", () => {
  it("classes the one error type the pack verifier throws", () => {
    expect(QualityPackError).toBe(QualityPackErrorLeaf);
  });

  it.each(PACK_CODES)(
    "classes a QualityPackError with code %s as infrastructure and names the restore step",
    (code) => {
      const error = new QualityPackError(code);
      expect(toOperatorErrorEnvelope(error)).toMatchObject({
        code,
        nextAction: SOURCE_CHECKOUT_RESTORE,
        failure: { class: "infrastructure", layer: "cli", code },
      });
      expect(classifyThrownFailure(error, "workflow")).toEqual({
        class: "infrastructure",
        layer: "workflow",
        code,
      });
    },
  );

  it.each(OTHER_THROWERS)("keeps %s with code %s unknown", (_thrower, code, make) => {
    const error = make();
    expect(toOperatorErrorEnvelope(error).failure).toEqual({
      class: "unknown",
      layer: "cli",
      code,
    });
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "unknown",
      layer: "workflow",
      code,
    });
  });

  it("catalogs every pack code for doctor and lets a bare code class only what the pack alone throws", () => {
    for (const code of PACK_CODES) expect(DOCTOR_DIAGNOSTIC_CODES, code).toContain(code);
    // `invalid-manifest` is the one pack code no other error throws.
    expect(operatorCodeFailureClass("invalid-manifest")).toBe("infrastructure");
    for (const [, code] of OTHER_THROWERS) {
      expect(operatorCodeFailureClass(code), code).toBe("unknown");
    }
  });
});
