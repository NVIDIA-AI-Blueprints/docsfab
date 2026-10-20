// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { compileTerminalSlice } from "./helpers/compiled-terminal-slice.mjs";
import {
  createHostedCreateFixture,
  controlledHostedCreateHarness,
} from "./helpers/hosted-create.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

it("preserves canonical CREATE validation and changing limits in source and compiled loader realms", {
  timeout: testTimeoutMs(120_000),
}, async () => {
  const fixture = await createHostedCreateFixture();
  const temporary = await mkdtemp(join(tmpdir(), "docsfab-terminal-validation-"));
  const compiled = join(temporary, "package");
  try {
    const controlled = controlledHostedCreateHarness(fixture.request, {
      technicalHumanReview: true,
    });
    const result = await runHostedWorkflow({
      request: fixture.request,
      credential: null,
      emit() {},
      executionHarness: controlled.harness,
    });
    expect(result.record.status, result.record.error).toBe("succeeded");
    const correction = result.record.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!.technicalCorrectionEvidence;
    expect(correction?.schemaVersion).toBe(3);
    if (correction?.schemaVersion !== 3) throw new Error("Expected actual V3 correction evidence.");
    expect(correction.proposal.issueJudgments[0]?.id).toBe("TECH-001");
    const fixturePath = join(temporary, "record.json");
    await writeFile(
      fixturePath,
      JSON.stringify({
        request: fixture.request,
        record: result.record,
        patch: result.patch,
        patchEvidence: result.patchEvidence,
        editorialOutcome: result.editorialOutcome,
      }),
    );
    const ledger = await compileTerminalSlice(packageRoot, compiled);
    expect(ledger.usedActualJsOnlyCopyHelper).toBe(true);
    expect(ledger.tsxInstalled).toBe(false);
    const environment: NodeJS.ProcessEnv = { PI_OFFLINE: "1", NO_AUTO_INSTALL: "1" };
    for (const name of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TERM",
    ]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    for (const mode of ["source", "compiled"] as const) {
      const args =
        mode === "source"
          ? ["--import", join(packageRoot, "node_modules/tsx/dist/loader.mjs")]
          : [];
      const observed = await execute(
        process.execPath,
        [
          ...args,
          join(packageRoot, "test/fixtures/host-invoker/terminal-validation-probe.mjs"),
          mode === "source" ? packageRoot : compiled,
          mode,
          fixturePath,
          join(temporary, `${mode}-limits.env`),
        ],
        { cwd: temporary, env: environment },
      );
      expect(observed.stderr).toBe("");
      expect(JSON.parse(observed.stdout)).toMatchObject({
        status: "PASS",
        mode,
        firstLoadNarrowSnapshotRefused: true,
        cachedSnapshotChangesObserved: true,
        snapshotRestoredAfterPassAndThrow: true,
        supportedEnvironmentOverrideParity: true,
        supportedFileRewriteParity: true,
        completeCreateTerminalPassed: true,
        canonicalMutationsRefused: 4,
        compiledWithoutTsx: mode === "compiled",
      });
    }
  } finally {
    await fixture.cleanup();
    await rm(temporary, { recursive: true, force: true });
  }
});
