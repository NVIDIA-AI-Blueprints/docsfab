// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  presentActivity,
  presentCollection,
  presentDecision,
  presentInspection,
  presentResult,
  readPresentationEnvironmentFacts,
  renderPresentation,
  resolvePresentationCapabilities,
  resolveProcessPresentationCapabilities,
  unicodeCellWidth,
  type PresentationCapabilityInput,
  type PresentationField,
} from "../src/operator/index.js";
import { styleTerminalText } from "../src/operator/terminal-style.js";

const evidence = (value: string): PresentationField["evidence"] => ({ state: "known", value });
const oneLine = (text: string): string => text.replace(/\s+/gu, " ");

function capabilities(overrides: Partial<PresentationCapabilityInput> = {}) {
  return resolvePresentationCapabilities({
    stdout: { isTTY: false, columns: 28 },
    stderr: { isTTY: false, columns: 21 },
    environment: { noColorPresent: false, forceColor: false, ci: false, termDumb: false },
    unicode: true,
    ...overrides,
  });
}

describe("operator presentation primitives", () => {
  it("projects results, attention, actions, artifacts, and disclosure without losing typed distinctions", () => {
    const command = {
      kind: "argv" as const,
      label: "Continue",
      executable: "docsfab",
      args: ["do", `Review O'Reilly's 文档`, "--repo", "/repo path"],
    };
    const document = presentResult(
      {
        title: "Review result",
        summary: "A useful result with selected repository scope.",
        outcome: { label: "Outcome", evidence: evidence("ready") },
        scope: { label: "Repository", evidence: evidence("/work/docs") },
        attention: { message: "Provider check was not requested.", stream: "stderr" },
        limitations: [
          { label: "Connectivity", evidence: evidence("unknown"), importance: "material" },
        ],
        primaryAction: command,
        nextActions: [{ kind: "instruction", text: "Use the same selected repository." }],
        artifacts: [{ kind: "link", label: "Saved record", href: "https://example.test/run/1" }],
        sections: [
          {
            title: "Diagnostics",
            detail: "verbose",
            fields: [
              { label: "Routine inventory", evidence: evidence("hidden in compact views") },
              {
                label: "Material qualification",
                evidence: evidence("must remain"),
                importance: "material",
              },
            ],
          },
        ],
      },
      { detail: "quiet" },
    );

    const text = document.rows.map((row) =>
      row.kind === "field"
        ? row.evidence.state === "known"
          ? row.evidence.value
          : "unknown"
        : row.kind === "attention"
          ? row.message
          : row.kind,
    );
    expect(text).toContain("ready");
    expect(text).toContain("/work/docs");
    expect(text).toContain("Provider check was not requested.");
    expect(text).toContain("unknown");
    expect(text).toContain("must remain");
    expect(text).not.toContain("hidden in compact views");
    expect(document.actions[0]).toEqual(command);

    const normalDocument = presentResult(
      {
        title: "Diagnostics",
        outcome: { label: "Outcome", evidence: evidence("ready") },
        attention: null,
        sections: [
          {
            title: "Verbose diagnostics",
            detail: "verbose",
            fields: [
              { label: "Routine", evidence: evidence("must stay hidden") },
              {
                label: "Material limitation",
                evidence: evidence("must stay visible"),
                importance: "material",
              },
            ],
          },
        ],
      },
      { detail: "normal" },
    );
    expect(JSON.stringify(normalDocument.rows)).toContain("must stay visible");
    expect(JSON.stringify(normalDocument.rows)).not.toContain("must stay hidden");

    const verboseDocument = presentResult(
      {
        title: "Verbose diagnostics",
        outcome: { label: "Outcome", evidence: evidence("ready") },
        attention: null,
        sections: [
          {
            title: "Mixed diagnostics",
            fields: [
              {
                label: "Material limitation",
                evidence: evidence("retain this"),
                importance: "material",
              },
              { label: "Supporting detail", evidence: evidence("retain this too") },
            ],
            text: ["Supporting note"],
            actions: [{ kind: "instruction", text: "Supporting action" }],
          },
        ],
      },
      { detail: "verbose" },
    );
    const verboseRows = JSON.stringify(verboseDocument.rows);
    expect(verboseRows).toContain('"retain this"');
    expect(verboseRows).toContain('"retain this too"');
    expect(verboseRows).toContain("Supporting note");
    expect(verboseRows).toContain("Supporting action");

    const sectionStream = presentResult({
      title: "Stream inheritance",
      outcome: { label: "Outcome", evidence: evidence("ready") },
      attention: null,
      sections: [
        {
          title: "Diagnostics",
          stream: "stderr",
          fields: [{ label: "Detail", evidence: evidence("must stay on stderr") }],
        },
      ],
    });
    expect(sectionStream.rows).toContainEqual(
      expect.objectContaining({ kind: "field", label: "Detail", stream: "stderr" }),
    );

    const rendered = renderPresentation(document, capabilities());
    expect(oneLine(rendered.stderr)).toContain("ATTENTION: Provider check was not requested.");
    expect(rendered.stdout).not.toContain("Provider check was not requested.");
    expect(rendered.stdout).toContain(
      `'docsfab' 'do' 'Review O'\\''Reilly'\\''s 文档' '--repo' '/repo path'`,
    );
    expect(rendered.stdout).toContain("Saved record: https://example.test/run/1");
  });

  it("keeps explicitly requested inspections and decision effects visible at every detail level", () => {
    const inspection = presentInspection(
      {
        title: "Limits",
        subject: { state: "unknown", explanation: "The provider did not expose this value." },
        findings: [{ label: "Context", evidence: evidence("Available") }],
        attention: null,
        sections: [{ title: "Extra trace", detail: "verbose", text: ["Optional trace"] }],
      },
      { detail: "quiet" },
    );
    const decision = presentDecision(
      {
        title: "Approval",
        question: "Apply the proposed change?",
        choices: [{ label: "Effect", evidence: evidence("Writes one file"), detail: "verbose" }],
        selected: { state: "unknown" },
        attention: null,
      },
      { detail: "quiet" },
    );
    expect(JSON.stringify(inspection.rows)).toContain("The provider did not expose this value.");
    expect(JSON.stringify(inspection.rows)).toContain("Available");
    expect(JSON.stringify(inspection.rows)).not.toContain("Optional trace");
    expect(JSON.stringify(decision.rows)).toContain("Writes one file");
    expect(JSON.stringify(decision.rows)).toContain('"state":"unknown"');
  });

  it("uses the same pure patterns for collections and observed activity", () => {
    const collection = presentCollection({
      title: "Runs",
      entries: [
        { label: "Run A", evidence: evidence("succeeded") },
        { label: "Run B", evidence: { state: "unknown", explanation: "Record unavailable." } },
      ],
      attention: null,
    });
    const activity = presentActivity({
      title: "Progress",
      events: [
        { identity: "step-1", phase: "running", message: "Read sources", observedWait: false },
        {
          identity: "provider",
          phase: "waiting",
          message: "Waiting for provider",
          observedWait: true,
        },
      ],
      attention: null,
    });
    const renderedCollection = renderPresentation(collection, capabilities());
    const renderedActivity = renderPresentation(activity, capabilities());
    expect(renderedCollection.stdout).toContain("Run A: succeeded");
    expect(oneLine(renderedCollection.stdout)).toContain("Run B: unknown (Record unavailable.)");
    expect(oneLine(renderedActivity.stdout)).toContain("running step-1: Read sources");
    expect(oneLine(renderedActivity.stdout)).toContain(
      "Waiting: waiting provider: Waiting for provider",
    );
  });

  it("wraps prose by terminal cell width and preserves full content in narrow and wide displays", () => {
    const document = presentResult({
      title: "Documentación revisión",
      outcome: { label: "Outcome", evidence: evidence("ready") },
      summary:
        "A narrow terminal still receives every word and wide CJK characters wrap by display cells.",
      attention: null,
    });
    const narrow = renderPresentation(
      document,
      capabilities({ stdout: { isTTY: false, columns: 22 } }),
    );
    const wide = renderPresentation(
      document,
      capabilities({ stdout: { isTTY: false, columns: 100 } }),
    );
    expect(narrow.stdout).toContain("display cells.");
    expect(wide.stdout).toContain(
      "A narrow terminal still receives every word and wide CJK characters wrap by display cells.",
    );
    for (const line of narrow.stdout.trimEnd().split("\n")) {
      expect(unicodeCellWidth(line)).toBeLessThanOrEqual(22);
    }
    expect(unicodeCellWidth("A界e\u0301👩‍💻")).toBe(6);
  });

  it("splits oversized tokens by grapheme cells without losing adjacent text", () => {
    const digest = "x".repeat(64);
    const cjk = "界".repeat(8);
    const document = presentResult({
      title: "Narrow output",
      outcome: { label: "Outcome", evidence: evidence("ready") },
      summary: `Digest: ${digest} ${cjk} still wraps after it.`,
      attention: null,
    });
    const rendered = renderPresentation(
      document,
      capabilities({ stdout: { isTTY: false, columns: 12 } }),
    );
    const lines = rendered.stdout.trimEnd().split("\n");
    expect(rendered.stdout.replaceAll(/[^x]/gu, "")).toHaveLength(64);
    expect(rendered.stdout.replaceAll(/[^界]/gu, "")).toHaveLength(8);
    expect(rendered.stdout.replaceAll(/\s+/gu, " ")).toContain("still wraps after it.");
    for (const line of lines) expect(unicodeCellWidth(line)).toBeLessThanOrEqual(12);
  });

  it("escapes terminal controls and retains original control-bearing argv as explicitly non-copyable", () => {
    const original = "review\n--force\u001b[2J\u202e​";
    const document = presentResult({
      title: "Unsafe \u009b title",
      outcome: { label: "Outcome", evidence: evidence("ready\u202e") },
      primaryAction: { kind: "argv", label: "Resume", executable: "docsfab", args: [original] },
      attention: null,
    });
    expect(document.actions[0]).toEqual({
      kind: "argv",
      label: "Resume",
      executable: "docsfab",
      args: [original],
    });
    const output = renderPresentation(document, capabilities());
    expect(output.stdout).toContain("Unsafe \\u{9b} title");
    expect(output.stdout).toContain("ready\\u{202e}");
    expect(oneLine(output.stdout)).toContain(
      "not copyable because it contains control or format characters",
    );
    expect(output.stdout).not.toContain("\u202e");
    expect(output.stdout).not.toContain("\u009b");
  });

  it("resolves independent streams and central color precedence, including empty NO_COLOR", () => {
    expect(readPresentationEnvironmentFacts({ NO_COLOR: "" })).toMatchObject({
      noColorPresent: true,
    });
    expect(readPresentationEnvironmentFacts({ FORCE_COLOR: "0" })).toMatchObject({
      forceColor: false,
      forceColorDisabled: true,
    });
    const resolved = capabilities({
      stdout: { isTTY: true, columns: 70 },
      stderr: { isTTY: false, columns: 34 },
      environment: { noColorPresent: false, forceColor: true, ci: true, termDumb: false },
    });
    expect(resolved.stdout).toMatchObject({
      isTTY: true,
      color: true,
      ornaments: true,
      columns: 70,
    });
    expect(resolved.stderr).toMatchObject({
      isTTY: false,
      color: true,
      ornaments: false,
      columns: 34,
    });
    expect(
      resolvePresentationCapabilities({
        stdout: { isTTY: true },
        stderr: { isTTY: true },
        environment: { noColorPresent: true, forceColor: true, ci: false, termDumb: false },
      }).stdout,
    ).toMatchObject({ color: false, ornaments: false });
    expect(
      resolvePresentationCapabilities({
        stdout: { isTTY: true },
        stderr: { isTTY: true },
        environment: { noColorPresent: false, forceColor: true, ci: false, termDumb: true },
      }).stdout,
    ).toMatchObject({ color: true, ornaments: false });
    expect(
      resolvePresentationCapabilities({
        stdout: { isTTY: true },
        stderr: { isTTY: true },
        environment: {
          noColorPresent: false,
          forceColor: false,
          forceColorDisabled: true,
          ci: false,
          termDumb: false,
        },
      }).stdout,
    ).toMatchObject({ color: false, ornaments: false });
    expect(
      resolveProcessPresentationCapabilities({
        stdout: { isTTY: true, columns: 80 },
        stderr: { isTTY: false, columns: 40 },
        environment: { noColorPresent: true, forceColor: true, ci: false, termDumb: false },
      }),
    ).toMatchObject({
      stdout: { color: false, columns: 80 },
      stderr: { color: false, columns: 40 },
    });
  });

  it("lets an explicit force-color override replace detected FORCE_COLOR=0", () => {
    const original = process.env.FORCE_COLOR;
    try {
      process.env.FORCE_COLOR = "0";
      expect(
        resolveProcessPresentationCapabilities({
          stdout: { isTTY: true },
          stderr: { isTTY: false },
          environment: {
            noColorPresent: false,
            forceColor: true,
            ci: false,
            termDumb: false,
          },
        }).stdout,
      ).toMatchObject({ color: true, ornaments: true });
    } finally {
      if (original === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = original;
    }
  });

  it("keeps legacy terminal-style colors on the shared ANSI palette", () => {
    expect(styleTerminalText("ready", { TERM: "xterm" }, { bold: true, nvidiaGreen: true })).toBe(
      "\u001b[1m\u001b[38;2;118;185;0mready\u001b[0m",
    );
    expect(styleTerminalText("ready", { NO_COLOR: "" }, { warning: true })).toBe("ready");
    expect(styleTerminalText("ready", { TERM: "xterm", FORCE_COLOR: "0" }, { warning: true })).toBe(
      "ready",
    );
  });
});
