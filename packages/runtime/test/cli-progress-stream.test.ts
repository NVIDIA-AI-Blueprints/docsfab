// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrintProgressHandler } from "../src/cli/progress.js";
import type { ArtifactUse } from "../src/artifacts/index.js";
import type { WorkflowDefinition, WorkflowStep } from "../src/workflow-contracts/contracts.js";

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const ENV_KEYS = ["NO_COLOR", "FORCE_COLOR", "CI", "TERM"] as const;

/**
 * Scrubs (and restores) the env vars `resolveCliFormatOptions` reads. `CI=true`
 * and `TERM=dumb` both disable terminal ornaments, so TTY assertions must clear
 * them to exercise the intended stream mode deterministically.
 */
function withEnv<T>(
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => T,
): T {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function collectingWrite(): { write: (text: string) => void; chunks: string[] } {
  const chunks: string[] = [];
  return {
    write: (text: string) => {
      chunks.push(text);
    },
    chunks,
  };
}

function progressStep(id: string): WorkflowStep {
  return { id, title: id, skill: "progress-fixture", mode: "read-only", prompt: "" };
}

const polishWorkflow = {
  steps: [progressStep("audit-before-polish"), progressStep("apply-polish")],
} satisfies Pick<WorkflowDefinition, "steps">;
const auditWorkflow = {
  steps: [progressStep("audit-docs")],
} satisfies Pick<WorkflowDefinition, "steps">;

describe("createPrintProgressHandler / pipe (non-TTY, CI, NO_COLOR)", () => {
  it("prints one append-only line per step status with no carriage return and no elapsed", () => {
    withEnv({}, () => {
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, { tty: false, write });

      handler({
        type: "step-status",
        sequence: 1,
        runId: "run-1",
        stepId: "audit-docs",
        status: "running",
      });
      handler({
        type: "step-status",
        sequence: 2,
        runId: "run-1",
        stepId: "audit-docs",
        status: "succeeded",
      });

      const out = chunks.join("");
      expect(out).toContain("PROGRESS");
      expect(out).toContain("step audit-docs: running");
      expect(out).toContain("step audit-docs: succeeded");
      expect(out).not.toContain("\r");
      expect(out).not.toMatch(/\d+s/);
    });
  });

  it("stays append-only on a TTY when NO_COLOR is set", () => {
    const { write, chunks } = collectingWrite();
    withEnv({ NO_COLOR: "1" }, () => {
      const handler = createPrintProgressHandler(false, { tty: true, write });
      handler({ type: "step-status", sequence: 1, runId: "run-1", stepId: "s", status: "running" });
    });
    expect(chunks.join("")).not.toContain("\r");
  });

  it("stays append-only on a TTY under CI=true without FORCE_COLOR", () => {
    const { write, chunks } = collectingWrite();
    withEnv({ CI: "true" }, () => {
      const handler = createPrintProgressHandler(false, { tty: true, write });
      handler({ type: "step-status", sequence: 1, runId: "run-1", stepId: "s", status: "running" });
    });
    expect(chunks.join("")).not.toContain("\r");
  });

  it("suppresses model text unless verbose and never emits a carriage return", () => {
    withEnv({}, () => {
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, { tty: false, write });
      handler({
        type: "text",
        sequence: 1,
        runId: "run-1",
        stepId: "s",
        text: "secret model prose",
      });
      expect(chunks.join("")).not.toContain("secret model prose");
    });
  });

  it("streams model text to stderr when verbose", () => {
    withEnv({}, () => {
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(true, { tty: false, write });
      handler({ type: "text", sequence: 1, runId: "run-1", stepId: "s", text: "model prose" });
      expect(chunks.join("")).toContain("model prose");
    });
  });

  it("dispose() is a harmless no-op on the pipe path", () => {
    withEnv({}, () => {
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, { tty: false, write });
      handler({ type: "step-status", sequence: 1, runId: "run-1", stepId: "s", status: "running" });
      const before = chunks.length;
      handler.dispose();
      expect(chunks.length).toBe(before);
    });
  });
});

describe("createPrintProgressHandler / TTY in-flight rewrite", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rewrites the running line in place with a carriage return, elapsed, and n/N, ticking about once a second", () => {
    withEnv({}, () => {
      vi.useFakeTimers();
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, {
        tty: true,
        write,
        workflow: polishWorkflow,
      });

      handler({
        type: "step-status",
        sequence: 1,
        runId: "run-1",
        stepId: "audit-before-polish",
        status: "running",
      });
      expect(chunks.join("")).toContain("\r  step 1/2  audit-before-polish  running  0s");

      vi.advanceTimersByTime(1000);
      expect(chunks.at(-1)).toBe("\r  step 1/2  audit-before-polish  running  1s");

      vi.advanceTimersByTime(2000);
      expect(chunks.at(-1)).toBe("\r  step 1/2  audit-before-polish  running  3s");

      handler.dispose();
    });
  });

  it("finalizes the in-flight line in place, stops ticking, and never rewrites completed history", () => {
    withEnv({}, () => {
      vi.useFakeTimers();
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, {
        tty: true,
        write,
        workflow: polishWorkflow,
      });

      handler({
        type: "step-status",
        sequence: 1,
        runId: "run-1",
        stepId: "audit-before-polish",
        status: "running",
      });
      vi.advanceTimersByTime(1000);
      handler({
        type: "step-status",
        sequence: 2,
        runId: "run-1",
        stepId: "audit-before-polish",
        status: "succeeded",
      });
      const afterFinishCount = chunks.length;
      const finished = chunks.join("");
      expect(finished).toContain("\r  step 1/2  audit-before-polish  succeeded");
      expect(finished.endsWith("\n")).toBe(true);

      // Advancing time after the step finished must not redraw the closed line.
      vi.advanceTimersByTime(5000);
      expect(chunks.length).toBe(afterFinishCount);

      handler({
        type: "step-status",
        sequence: 3,
        runId: "run-1",
        stepId: "apply-polish",
        status: "running",
      });
      const combined = chunks.join("");
      expect(combined).toContain("step 2/2  apply-polish  running  0s");
      // The already-flushed step-1 history must still be intact, unmodified.
      expect(combined).toContain("step 1/2  audit-before-polish  succeeded");

      handler.dispose();
    });
  });

  it("pads over leftover characters when the rewritten line shrinks", () => {
    withEnv({}, () => {
      vi.useFakeTimers();
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, {
        tty: true,
        write,
        workflow: auditWorkflow,
      });
      handler({
        type: "step-status",
        sequence: 1,
        runId: "run-1",
        stepId: "audit-docs",
        status: "running",
      });
      vi.advanceTimersByTime(61_000);
      const longLine = chunks.at(-1)!;
      expect(longLine).toBe("\r  step 1/1  audit-docs  running  1m 1s");

      handler({
        type: "step-status",
        sequence: 2,
        runId: "run-1",
        stepId: "audit-docs",
        status: "failed",
      });
      const finalLine = chunks.at(-2)!; // last write before the trailing "\n"
      expect(finalLine.startsWith("\r  step 1/1  audit-docs  failed")).toBe(true);
      expect(finalLine.length).toBe(longLine.length);
      expect(chunks.at(-1)).toBe("\n");

      handler.dispose();
    });
  });

  it("omits n/N when no workflow is provided, but still rewrites in place", () => {
    withEnv({}, () => {
      vi.useFakeTimers();
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, { tty: true, write });
      handler({
        type: "step-status",
        sequence: 1,
        runId: "run-1",
        stepId: "audit-docs",
        status: "running",
      });
      expect(chunks.join("")).toContain("\r  step audit-docs  running  0s");
      handler.dispose();
    });
  });

  it("breaks the in-flight line before run-status events instead of erasing them", () => {
    withEnv({}, () => {
      vi.useFakeTimers();
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, { tty: true, write });
      handler({ type: "run-status", sequence: 1, runId: "run-1", status: "running" });
      expect(chunks.join("")).toContain("PROGRESS");
      expect(chunks.join("")).toContain("  run run-1: running\n");

      handler({
        type: "step-status",
        sequence: 2,
        runId: "run-1",
        stepId: "audit-docs",
        status: "running",
      });
      // The step's in-flight line must not have erased the run-status line.
      const combined = chunks.join("");
      expect(combined).toContain("run run-1: running\n");
      expect(combined).toContain("\r  step audit-docs  running  0s");
      handler.dispose();
    });
  });

  it("leaves a blank line after a terminal run-status so VERDICT does not slam into PROGRESS", () => {
    withEnv({}, () => {
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, { tty: true, write });
      handler({ type: "run-status", sequence: 1, runId: "run-1", status: "running" });
      handler({ type: "run-status", sequence: 2, runId: "run-1", status: "succeeded" });
      expect(chunks.join("")).toMatch(/run run-1: succeeded\n\n$/u);
      handler.dispose();
    });
  });

  it("breaks the in-flight line before an artifact-reference so the finalize afterward never erases it", () => {
    withEnv({}, () => {
      vi.useFakeTimers();
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, { tty: true, write });
      handler({
        type: "step-status",
        sequence: 1,
        runId: "run-1",
        stepId: "audit-docs",
        status: "running",
      });
      handler({
        type: "artifact-reference",
        sequence: 2,
        runId: "run-1",
        stepId: "audit-docs",
        status: "referenced",
        artifact: {
          role: "input",
          reference: {
            kind: "ia-plan",
            schemaVersion: 1,
            digest: "sha256:abc",
            repositoryRevision: "deadbeef",
            repositoryContentDigest: "sha256:content",
          },
        } satisfies ArtifactUse,
      });
      handler({
        type: "step-status",
        sequence: 3,
        runId: "run-1",
        stepId: "audit-docs",
        status: "succeeded",
      });
      const combined = chunks.join("");
      expect(combined).toContain("artifact ia-plan:sha256:abc (input)\n");
      // The finalize after the artifact line must append, never CR-erase it.
      expect(combined).toContain("step audit-docs  succeeded\n");
      expect(combined).not.toMatch(/artifact[^\n]*\r/);
      handler.dispose();
    });
  });

  it("breaks the in-flight line before verbose text so it is never carriage-returned over", () => {
    withEnv({}, () => {
      vi.useFakeTimers();
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(true, {
        tty: true,
        write,
        workflow: polishWorkflow,
      });
      handler({
        type: "step-status",
        sequence: 1,
        runId: "run-1",
        stepId: "audit-before-polish",
        status: "running",
      });
      handler({
        type: "text",
        sequence: 2,
        runId: "run-1",
        stepId: "audit-before-polish",
        text: "prose",
      });
      expect(chunks).toContain("\n");
      const textIndex = chunks.indexOf("prose");
      expect(chunks[textIndex - 1]).toBe("\n");
      handler.dispose();
    });
  });

  it("dispose() closes a still-open in-flight line and stops the tick", () => {
    withEnv({}, () => {
      vi.useFakeTimers();
      const { write, chunks } = collectingWrite();
      const handler = createPrintProgressHandler(false, { tty: true, write });
      handler({
        type: "step-status",
        sequence: 1,
        runId: "run-1",
        stepId: "audit-docs",
        status: "running",
      });
      handler.dispose();
      expect(chunks.at(-1)).toBe("\n");
      const afterDisposeCount = chunks.length;
      vi.advanceTimersByTime(5000);
      expect(chunks.length).toBe(afterDisposeCount);
    });
  });
});

describe("no spinner library", () => {
  const spinnerLibraries = [
    "ora",
    "chalk",
    "cli-spinner",
    "listr",
    "listr2",
    "nanospinner",
    "cli-progress",
  ];

  it("does not add a spinner or ANSI-styling dependency to package.json", () => {
    const dependencies = {
      ...packageManifest.dependencies,
      ...packageManifest.devDependencies,
    };
    for (const forbidden of spinnerLibraries) {
      expect(Object.keys(dependencies)).not.toContain(forbidden);
    }
  });
});
