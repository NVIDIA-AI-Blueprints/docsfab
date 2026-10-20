// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DurableArtifactStore } from "../src/artifacts/index.js";
import { limit, limitDefinition } from "../src/config/limits.js";
import type { SelectedDocumentationQualityProfile } from "../src/evaluation-report/quality-profile-selection.js";
import {
  QualityDerivationError,
  QualityValidatorHost,
  type QualityDerivationInputV1,
} from "../src/evaluation-report/quality-validator-host.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(runtimeRoot, "../..");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

let pack: Awaited<ReturnType<typeof verifyQualityPackContext>>;
beforeAll(async () => {
  pack = await verifyQualityPackContext({
    qualityDirectory: `${runtimeRoot}/quality`,
    qualityPackDirectory: `${runtimeRoot}/quality-pack`,
    skillCrateDirectory: `${runtimeRoot}/skill-crate`,
  });
});

const lockedDigest = (path: string) =>
  pack.qualityLock.files.find((file) => file.path === path)!.sha256;

async function host(
  options: { executable?: string; timeoutMs?: number; lock?: typeof pack.qualityLock } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-quality-derive-"));
  roots.push(root);
  const selection = {
    pack: { ...pack, qualityLock: options.lock ?? pack.qualityLock },
  } as unknown as SelectedDocumentationQualityProfile;
  return {
    root,
    host: new QualityValidatorHost({
      store: new DurableArtifactStore(join(root, "artifacts")),
      selection,
      temporaryRoot: join(root, "validator-tmp"),
      stateDirectory: join(root, "state"),
      ...(options.executable ? { executable: options.executable } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    }),
  };
}

/** Fixture a as a derivation input: each layer's gates attributed on its first dimension (O4). */
async function fixtureInput(): Promise<QualityDerivationInputV1> {
  const evaluation = JSON.parse(
    await readFile(
      join(
        repositoryRoot,
        "packages/quality/tests/fixtures/documentation-quality-evaluation/review-live-main-f05a81f1-a.json",
      ),
      "utf8",
    ),
  ) as Record<string, any>;
  const gateAttribution: Record<string, string[]> = {};
  for (const layer of Object.values(evaluation.layers as Record<string, any>)) {
    if (layer.hard_gate_failures.length > 0) {
      gateAttribution[layer.dimensions[0].dimension_id] = layer.hard_gate_failures;
    }
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-quality-derivation-input",
    evaluation,
    qualityScore: null,
    gateAttribution,
    layerShortfallDecisions: {},
    textPathGates: null,
  };
}

/** A stand-in interpreter that runs `body` with the deriver's output path as `$out`. */
let fakes = 0;
async function fakeInterpreter(root: string, body: string): Promise<string> {
  fakes += 1;
  const path = join(root, `fake-python3-${fakes}`);
  await writeFile(path, `#!/bin/sh\nout="$6"\n${body}\n`);
  await chmod(path, 0o700);
  return path;
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(QualityDerivationError);
  expect((error as QualityDerivationError).code).toBe("quality-derivation-failed");
  expect((error as QualityDerivationError).retryable).toBe(false);
  return (error as QualityDerivationError).reason;
}

describe("quality validator host derive() (design §1.2, N12, N14)", {
  timeout: testTimeoutMs(60_000),
}, () => {
  it("derives fixture a through the locked deriver into a digest-checked private file", async () => {
    const { host: validatorHost, root } = await host();
    const input = await fixtureInput();
    const derived = await validatorHost.derive(input);
    expect(derived.status).toBe("derived");
    if (derived.status !== "derived") return;
    for (const [layer, result] of Object.entries(
      derived.evaluation.layers as Record<string, any>,
    )) {
      expect(result.decision, layer).toBe(input.evaluation.layers[layer].decision);
      expect(result.hard_gate_failures, layer).toEqual(
        input.evaluation.layers[layer].hard_gate_failures,
      );
    }
    expect(derived.evaluation.overall_decision).toBe("fail");
    expect(derived.hostLimitations.length).toBeGreaterThan(0);
    // The receipt binds the locked script, rule module, and profile, and the output digest.
    expect(derived.receipt.scriptSha256).toBe(
      lockedDigest("checks/derive_documentation_quality_evaluation.py"),
    );
    expect(derived.receipt.inputPayloadSha256s.slice(1)).toEqual([
      lockedDigest("checks/quality_decision_policy.py"),
      lockedDigest("profiles/docsfab-documentation-quality/profile.json"),
    ]);
    expect(derived.receipt.outputSha256).toMatch(/^[0-9a-f]{64}$/u);
    // Nothing is left under the temporary root.
    const left = await readFile(join(root, "validator-tmp"), "utf8").catch((error) => error.code);
    expect(left).toBe("EISDIR");
  });

  it("returns the layers the rules leave open, for their residual (O2)", async () => {
    const { host: validatorHost } = await host();
    const input = await fixtureInput();
    const layer = input.evaluation.layers.transferable_understanding;
    // A gateless shortfall with every required dimension assessed (D3).
    for (const dimension of layer.dimensions) {
      dimension.assessment = dimension.assessment === "not-applicable" ? "partially-met" : "met";
      if (dimension.assessment === "met" && dimension.evidence.length === 0) {
        dimension.assessment = "partially-met";
      }
    }
    layer.dimensions[0].assessment = "not-met";
    const attribution = { ...input.gateAttribution };
    delete attribution[layer.dimensions[0].dimension_id];
    const derived = await validatorHost.derive({ ...input, gateAttribution: attribution });
    expect(derived).toMatchObject({ status: "open", openLayers: ["transferable_understanding"] });
  });

  it("stops with quality-derivation-failed for every deriver failure, never as model content", async () => {
    const input = await fixtureInput();
    const scratch = await mkdtemp(join(tmpdir(), "docsfab-quality-derive-fake-"));
    roots.push(scratch);
    const cases: [string, Promise<{ host: QualityValidatorHost }>][] = [
      ["deriver-unavailable", host({ executable: join(scratch, "no-such-python3") })],
      ["deriver-exit", host({ executable: await fakeInterpreter(scratch, "exit 3") })],
      [
        "deriver-timeout",
        host({ executable: await fakeInterpreter(scratch, "sleep 5"), timeoutMs: 1000 }),
      ],
      ["output-missing", host({ executable: await fakeInterpreter(scratch, "exit 0") })],
      [
        "output-not-regular",
        host({
          executable: await fakeInterpreter(
            scratch,
            `printf '{}' > "$out.real"; ln -s "$out.real" "$out"`,
          ),
        }),
      ],
      // A symlink whose target holds exactly as many bytes as the link's own
      // size: only the lstat type check stops the host from reading through it.
      [
        "output-not-regular",
        host({
          executable: await fakeInterpreter(
            scratch,
            `t="$out.real"; head -c \${#t} /dev/zero | tr '\\0' ' ' > "$t"; ln -s "$t" "$out"`,
          ),
        }),
      ],
      [
        "output-oversize",
        host({
          executable: await fakeInterpreter(
            scratch,
            `head -c ${limit("qualityValidator.maxDerivedArtifactBytes").value + 1} /dev/zero | tr '\\0' ' ' > "$out"`,
          ),
        }),
      ],
      [
        "output-undecodable",
        host({ executable: await fakeInterpreter(scratch, `printf 'not json' > "$out"`) }),
      ],
      [
        "output-contract",
        host({
          executable: await fakeInterpreter(
            scratch,
            `printf '{"schemaVersion":1,"kind":"docsfab-quality-derivation-output","status":"derived"}' > "$out"`,
          ),
        }),
      ],
    ];
    for (const [reason, made] of cases) {
      const { host: validatorHost } = await made;
      expect(await reasonOf(validatorHost.derive(input)), reason).toBe(reason);
    }
  });

  it("refuses a tampered rule module lock and an unscreened input before any spawn", async () => {
    const input = await fixtureInput();
    const tampered = {
      ...pack.qualityLock,
      files: pack.qualityLock.files.map((file) =>
        file.path === "checks/quality_decision_policy.py"
          ? { ...file, sha256: "0".repeat(64) }
          : file,
      ),
    };
    const { host: lockHost } = await host({ lock: tampered });
    expect(await reasonOf(lockHost.derive(input))).toBe("input-integrity");

    const scratch = await mkdtemp(join(tmpdir(), "docsfab-quality-derive-spawn-"));
    roots.push(scratch);
    const marker = join(scratch, "spawned");
    const { host: watched } = await host({
      executable: await fakeInterpreter(scratch, `touch "${marker}"; exit 0`),
    });
    const credential = configureCredential(["meadow", plantedCredentialValue(17, 24)].join("-"));
    const leaked = structuredClone(input) as QualityDerivationInputV1 & {
      evaluation: Record<string, any>;
    };
    leaked.evaluation.layers.trustworthy_information.dimensions[0].rationale = `see ${credential}`;
    expect(await reasonOf(watched.derive(leaked))).toBe("input-not-screened");
    const nonInert = structuredClone(input) as QualityDerivationInputV1 & {
      evaluation: Record<string, any>;
    };
    nonInert.evaluation.confidence = Number.NaN;
    expect(await reasonOf(watched.derive(nonInert))).toBe("input-not-screened");
    expect(await readFile(marker).catch(() => "not spawned")).toBe("not spawned");
  });

  it("reads its spawn bounds from the qualityValidator limits", async () => {
    expect(
      () =>
        new QualityValidatorHost({
          store: new DurableArtifactStore(join(tmpdir(), "unused")),
          selection: { pack } as unknown as SelectedDocumentationQualityProfile,
          temporaryRoot: tmpdir(),
          stateDirectory: join(tmpdir(), "unused-state"),
          timeoutMs: limitDefinition("qualityValidator.timeoutMs").max + 1,
        }),
    ).toThrow("The configured quality validator timeout value is invalid.");
  });
});
