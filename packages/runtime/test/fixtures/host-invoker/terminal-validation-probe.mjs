// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Actual canonical source/dist parity in a fresh process; no replacement validator. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, mode, fixturePath, hostLimitsPath] = process.argv.slice(2);
assert.ok(mode === "source" || mode === "compiled");
await writeFile(hostLimitsPath, "");
process.env.DOCSFAB_SERVICE_ENV_FILE = hostLimitsPath;
const base = mode === "source" ? "src" : "dist";
const suffix = mode === "source" ? "ts" : "js";
const moduleUrl = (path) => pathToFileURL(join(packageRoot, base, `${path}.${suffix}`)).href;
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const caller = await import(moduleUrl("contract-kit/decode-bounds"));
const direct = await import(moduleUrl("records/authoring-execution"));
const catalog = await import(moduleUrl("workflow-registry/declarative"));
const bridge = await import(moduleUrl("host-invoker/terminal-validation"));
const workflow = catalog.getDeclarativeWorkflow("create-documentation");
const options = { requireTerminalSuccess: true };
const baseline = caller.contractDecodeLimits();
const call = () => bridge.validateAuthoringRunRecordV1(fixture.record, workflow, options);
const directCall = () => direct.validateAuthoringRunRecordV1(fixture.record, workflow, options);
const narrow = { ...baseline, maxArrayLength: 1 };
let canonical;
let canonicalPrior;
try {
  // This precedes the first lazy load, not merely a call through its cache.
  caller.installContractDecodeLimitSnapshot(narrow);
  assert.throws(call, /bound-exceeded/);
  assert.deepEqual(caller.contractDecodeLimits(), narrow);
  const runtimeRequire = createRequire(join(packageRoot, "package.json"));
  canonical =
    mode === "source"
      ? runtimeRequire("tsx/cjs/api").require(
          join(packageRoot, base, "host-invoker/terminal-validation-runtime.js"),
          import.meta.url,
        )
      : runtimeRequire(join(packageRoot, base, "host-invoker/terminal-validation-runtime.js"));
  const sameRealm = canonical.contractDecodeLimits() === caller.contractDecodeLimits();
  canonicalPrior = canonical.contractDecodeLimits();
  const independentPrior = { ...baseline, maxArrayLength: 2 };
  caller.installContractDecodeLimitSnapshot(baseline);
  if (!sameRealm) canonical.installContractDecodeLimitSnapshot(independentPrior);
  assert.doesNotThrow(call);
  assert.deepEqual(caller.contractDecodeLimits(), baseline);
  assert.deepEqual(canonical.contractDecodeLimits(), sameRealm ? baseline : independentPrior);

  caller.installContractDecodeLimitSnapshot(narrow);
  assert.throws(call, /bound-exceeded/);
  assert.deepEqual(caller.contractDecodeLimits(), narrow);
  assert.deepEqual(canonical.contractDecodeLimits(), sameRealm ? narrow : independentPrior);
  caller.installContractDecodeLimitSnapshot(baseline);
  assert.doesNotThrow(call);

  const badRecord = structuredClone(fixture.record);
  delete badRecord.authoringExecution;
  assert.throws(() => bridge.validateAuthoringRunRecordV1(badRecord, workflow, options));
  assert.deepEqual(caller.contractDecodeLimits(), baseline);
  assert.deepEqual(canonical.contractDecodeLimits(), sameRealm ? baseline : independentPrior);

  // The real record has TECH-001 (8 chars), so a supported 7-char limit must
  // reject it. Restoring 63 must admit it even after the bridge was cached.
  const assertBoth = (passes) => {
    for (const validate of [directCall, call]) {
      if (passes) assert.doesNotThrow(validate);
      else assert.throws(validate);
    }
  };
  process.env.DOCSFAB_TECHNICAL_CORRECTION_IDENTIFIER_MAX_CHARS = "7";
  assertBoth(false);
  process.env.DOCSFAB_TECHNICAL_CORRECTION_IDENTIFIER_MAX_CHARS = "63";
  assertBoth(true);
  delete process.env.DOCSFAB_TECHNICAL_CORRECTION_IDENTIFIER_MAX_CHARS;
  process.env.DOCSFAB_SERVICE_ENV_FILE = hostLimitsPath;
  await writeFile(hostLimitsPath, "DOCSFAB_TECHNICAL_CORRECTION_IDENTIFIER_MAX_CHARS=7\n");
  assertBoth(false);
  await writeFile(hostLimitsPath, "DOCSFAB_TECHNICAL_CORRECTION_IDENTIFIER_MAX_CHARS=63\n");
  assertBoth(true);
  delete process.env.DOCSFAB_SERVICE_ENV_FILE;

  const terminal = await import(moduleUrl("host-invoker/terminal"));
  const seal = (record) =>
    terminal.sealHostRuntimeTerminal({
      request: fixture.request,
      status: "succeeded",
      runtimeRecord: record,
      patch: fixture.patch,
      patchEvidence: fixture.patchEvidence,
      editorialOutcome: fixture.editorialOutcome,
    });
  const sealed = seal(fixture.record);
  assert.equal(
    terminal.parseHostRuntimeTerminalWire(JSON.parse(JSON.stringify(sealed)), fixture.request)
      .status,
    "succeeded",
  );
  const missingPhase = structuredClone(fixture.record);
  missingPhase.steps = missingPhase.steps.filter((step) => step.id !== "lint-documentation");
  const candidate = structuredClone(fixture.record);
  candidate.authoringExecution.selectedCandidate.ordinal = 1;
  const patch = structuredClone(fixture.record);
  patch.authoringExecution.finalPatch.candidateDigest = "f".repeat(64);
  for (const invalid of [badRecord, missingPhase, candidate, patch])
    assert.throws(() => seal(invalid));
  if (mode === "compiled") assert.throws(() => runtimeRequire.resolve("tsx/cjs/api"));
  console.log(
    JSON.stringify({
      status: "PASS",
      mode,
      sameRealm,
      runtime: process.version,
      firstLoadNarrowSnapshotRefused: true,
      cachedSnapshotChangesObserved: true,
      snapshotRestoredAfterPassAndThrow: true,
      distinctRealmRestorationTested: !sameRealm,
      supportedEnvironmentOverrideParity: true,
      supportedFileRewriteParity: true,
      completeCreateTerminalPassed: true,
      canonicalMutationsRefused: 4,
      compiledWithoutTsx: mode === "compiled",
    }),
  );
} finally {
  if (canonical && canonicalPrior) canonical.installContractDecodeLimitSnapshot(canonicalPrior);
  caller.installContractDecodeLimitSnapshot(baseline);
  delete process.env.DOCSFAB_TECHNICAL_CORRECTION_IDENTIFIER_MAX_CHARS;
  delete process.env.DOCSFAB_SERVICE_ENV_FILE;
}
