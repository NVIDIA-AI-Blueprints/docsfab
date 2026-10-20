// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessFocusedFinding,
  proofFixture,
  proofConversationSeconds,
  summarizeProofRun,
} from "./proof-assertions.mjs";

const roots = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("live proof outcome assertions", () => {
  it("isolates wording review from the progressive fixture's real technical defects", async () => {
    const focused = proofFixture("focused");
    const progressive = proofFixture("progressive");
    expect(focused.readme).toContain("export --output report.txt");
    expect(focused.readme).not.toContain("option is optional");
    expect(progressive.readme).toContain("option is optional");
    const root = await mkdtemp(join(tmpdir(), "docsfab-proof-cli-"));
    roots.push(root);
    await writeFile(join(root, "cli.mjs"), focused.cli);
    await promisify(execFile)(process.execPath, ["cli.mjs", "export", "--output", "report.txt"], {
      cwd: root,
    });
    expect(await readFile(join(root, "report.txt"), "utf8")).toBe("Bluebird plain-text report\n");
    for (const args of [["export"], ["export", "--output=report.txt"], ["export", "--output"]]) {
      await expect(
        promisify(execFile)(process.execPath, ["cli.mjs", ...args], { cwd: root }),
      ).rejects.toMatchObject({ code: 2 });
    }
  });
  it("accepts the observed source-backed command correction without demanding style keywords", () => {
    const answer =
      "The example omits the required --output argument. Run `node cli.mjs export --output report.txt` to save a plain-text report.";
    expect(assessFocusedFinding(answer, true, proofFixture("progressive").readme)).toEqual({
      clarityCorrection: false,
      groundedCommandCorrection: true,
    });
    expect(
      assessFocusedFinding(answer, false, proofFixture("progressive").readme)
        .groundedCommandCorrection,
    ).toBe(false);
    expect(
      assessFocusedFinding(answer, true, proofFixture("focused").readme).groundedCommandCorrection,
    ).toBe(false);
  });

  it.each([
    "I reviewed the required --output option.",
    "Use node cli.mjs export. The --output argument is missing.",
    "The required --output option saves report.txt.",
    "No correction is required; the README is accurate. For reference: node cli.mjs export --output report.txt.",
    "The source requires this invocation: node cli.mjs export --output report.txt.",
    "Do not add --output; it is optional. For reference: node cli.mjs export --output report.txt.",
    "Add the missing --output option: node cli.mjs export --output=report.txt.",
  ])("does not count an acknowledgment or uncorrected example as a correction: %s", (answer) => {
    expect(
      assessFocusedFinding(answer, true, proofFixture("progressive").readme)
        .groundedCommandCorrection,
    ).toBe(false);
  });

  it("still recognizes a concrete clarity correction", () => {
    expect(assessFocusedFinding('Remove the unsupported word "instantly".', false)).toEqual({
      clarityCorrection: true,
      groundedCommandCorrection: false,
    });
  });

  it("keeps the expanded budget specific to the workflow case", () => {
    expect(proofConversationSeconds("workflow")).toBe(900);
    for (const name of ["direct", "focused", "progressive", "clarification"])
      expect(proofConversationSeconds(name)).toBe(240);
  });

  it("retains failed and partial execution facts without exposing raw content", () => {
    const summary = summarizeProofRun({
      id: "abc123",
      workflow: "review-documentation",
      status: "failed",
      error: "PRIVATE",
      instruction: "PRIVATE",
      summary: "PRIVATE",
      qualityArtifactValidation: { failureCode: "evaluation-invalid" },
      steps: [
        { id: "audit-documentation", status: "succeeded", durationMs: 100 },
        { id: "evaluate-document-quality", status: "failed", summary: "PRIVATE" },
      ],
    });
    expect(summary).toMatchObject({
      status: "failed",
      qualityFailureCode: "evaluation-invalid",
      steps: [{ status: "succeeded", durationMs: 100 }, { status: "failed" }],
    });
    expect(JSON.stringify(summary)).not.toContain("PRIVATE");
    expect(summarizeProofRun({ status: "running", steps: [] }).status).toBe("running");
    expect(
      summarizeProofRun({
        status: "needs-human-decision",
        steps: [{ id: "audit-documentation", status: "pending" }],
      }),
    ).toMatchObject({ status: "needs-human-decision", steps: [{ status: "pending" }] });
    expect(
      summarizeProofRun({
        id: "PRIVATE /path",
        status: "PRIVATE",
        qualityArtifactValidation: { failureCode: "PRIVATE" },
      }),
    ).toMatchObject({ runId: undefined, status: "unknown", qualityFailureCode: undefined });
  });
});

describe.runIf(spawnSync("expect", ["-v"]).status === 0)("bounded proof terminal", () => {
  it("rejects a timeout beyond the finite cap before starting a child", async () => {
    await expect(
      promisify(execFile)("expect", [
        "-f",
        resolve("test/fixtures/live-agent-behavior/conversation.exp"),
        "/missing",
        "/unused",
        "hello",
        "901",
      ]),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("stops a stalled conversation with the explicit timeout result", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-proof-timeout-"));
    roots.push(root);
    const executable = join(root, "hang.mjs");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconsole.log("Session abcdefab-1234-5678-9012-abcdefabcdef"); process.stdout.write("You: "); process.stdin.resume();\n',
    );
    await chmod(executable, 0o700);
    await expect(
      promisify(execFile)(
        "expect",
        [
          "-f",
          resolve("test/fixtures/live-agent-behavior/conversation.exp"),
          executable,
          root,
          "hello",
          "1",
        ],
        { timeout: 5000 },
      ),
    ).rejects.toMatchObject({ code: 124 });
  }, 10_000);
});
