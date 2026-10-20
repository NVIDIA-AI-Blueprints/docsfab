// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  explainProductDisposition,
  formatCheckGrid,
  formatCliDuration,
  formatCliStatus,
  formatCliVerdictLine,
  formatCliVerdictPlaneRows,
  formatSectionHeader,
  paintCliText,
  resolveCliFormatOptions,
} from "../src/operator/cli-format.js";

const TTY = {
  tty: true,
  noColor: false,
  forceColor: false,
  forceColorDisabled: false,
  ci: false,
  termDumb: false,
} as const;
const PIPE = {
  tty: false,
  noColor: false,
  forceColor: false,
  forceColorDisabled: false,
  ci: false,
  termDumb: false,
} as const;
const NO_COLOR = {
  tty: true,
  noColor: true,
  forceColor: false,
  forceColorDisabled: false,
  ci: false,
  termDumb: false,
} as const;
const FORCE_PIPE = {
  tty: false,
  noColor: false,
  forceColor: true,
  forceColorDisabled: false,
  ci: false,
  termDumb: false,
} as const;
const CI_TTY = {
  tty: true,
  noColor: false,
  forceColor: false,
  forceColorDisabled: false,
  ci: true,
  termDumb: false,
} as const;
const CI_FORCE_TTY = {
  tty: true,
  noColor: false,
  forceColor: true,
  forceColorDisabled: false,
  ci: true,
  termDumb: false,
} as const;

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("cli format helpers", () => {
  it("uses plain section headers when stdout is not a TTY", () => {
    expect(formatSectionHeader("EXECUTION", { tty: false })).toBe("EXECUTION");
  });

  it("uses decorated section headers on a TTY", () => {
    expect(stripAnsi(formatSectionHeader("EXECUTION", TTY))).toBe("── EXECUTION ──");
    expect(formatSectionHeader("EXECUTION", TTY)).toContain("\u001b[1m");
  });

  it("renders one readiness row per area", () => {
    expect(
      formatCheckGrid(
        [
          { area: "installation", status: "ready" },
          { area: "gitlab", status: "blocked" },
        ],
        PIPE,
      ),
    ).toEqual(["  installation: ready", "  gitlab: blocked"]);
  });

  it("explains closed product dispositions in plain language", () => {
    expect(explainProductDisposition("ready")).toBe(
      "The workflow's product criteria are satisfied.",
    );
    expect(explainProductDisposition("not-ready")).toBe(
      "Execution succeeded, but documented product gaps remain.",
    );
    expect(explainProductDisposition("inconclusive")).toBe(
      "Evidence was insufficient for a definitive product verdict.",
    );
    expect(explainProductDisposition("blocked")).toBe(
      "A dependency or policy gate prevents completing the product outcome.",
    );
    expect(explainProductDisposition("needs-input")).toBe(
      "Governed external input is required before the product outcome can finalize.",
    );
    expect(explainProductDisposition("legacy-no-product-disposition")).toBe(
      "This run predates structured product disposition; inspect the run record.",
    );
  });
});

describe("cli visual dialect stream fixtures", () => {
  it("keeps detected environment values when a caller overrides only TTY", () => {
    const originalCi = process.env.CI;
    const originalNoColor = process.env.NO_COLOR;
    const originalForceColor = process.env.FORCE_COLOR;
    try {
      process.env.CI = "true";
      process.env.NO_COLOR = "1";
      expect(resolveCliFormatOptions({ tty: true })).toMatchObject({
        ci: true,
        noColor: true,
        ornaments: false,
        color: false,
      });
      delete process.env.NO_COLOR;
      process.env.CI = "false";
      process.env.FORCE_COLOR = "0";
      expect(resolveCliFormatOptions({ tty: true })).toMatchObject({
        forceColor: false,
        color: false,
        ornaments: false,
      });
    } finally {
      if (originalCi === undefined) delete process.env.CI;
      else process.env.CI = originalCi;
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
      if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = originalForceColor;
    }
  });

  it("TTY: ornaments and 16-color + bold", () => {
    expect(resolveCliFormatOptions(TTY)).toMatchObject({ ornaments: true, color: true });
    expect(stripAnsi(formatSectionHeader("EXECUTION", TTY))).toBe("── EXECUTION ──");
    expect(
      stripAnsi(formatCheckGrid([{ area: "installation", status: "ready" }], TTY)[0] ?? ""),
    ).toBe("  ✓ installation: ready");
    const painted = formatCliStatus("succeeded", TTY);
    expect(painted).toContain("\u001b[32m");
    expect(painted).toContain("\u001b[1m");
    expect(stripAnsi(painted)).toBe("succeeded");
  });

  it("pipe: no ornaments and no color", () => {
    expect(resolveCliFormatOptions(PIPE)).toMatchObject({ ornaments: false, color: false });
    expect(formatSectionHeader("EXECUTION", PIPE)).toBe("EXECUTION");
    expect(formatCliStatus("failed", PIPE)).toBe("failed");
    expect(formatCheckGrid([{ area: "installation", status: "ready" }], PIPE)).toEqual([
      "  installation: ready",
    ]);
  });

  it("NO_COLOR: TTY words without color or markers", () => {
    expect(resolveCliFormatOptions(NO_COLOR)).toMatchObject({ ornaments: false, color: false });
    expect(formatSectionHeader("PRODUCT", NO_COLOR)).toBe("PRODUCT");
    expect(formatCliStatus("ready", NO_COLOR)).toBe("ready");
    expect(formatCheckGrid([{ area: "gitlab", status: "blocked" }], NO_COLOR)).toEqual([
      "  gitlab: blocked",
    ]);
  });

  it("FORCE_COLOR on a pipe: color on, markers and banners off", () => {
    expect(resolveCliFormatOptions(FORCE_PIPE)).toMatchObject({ ornaments: false, color: true });
    expect(formatSectionHeader("RECORD", FORCE_PIPE)).toContain("\u001b[1m");
    expect(stripAnsi(formatSectionHeader("RECORD", FORCE_PIPE))).toBe("RECORD");
    const painted = formatCliStatus("failed", FORCE_PIPE);
    expect(painted).toContain("\u001b[31m");
    expect(stripAnsi(painted)).toBe("failed");
    const row = formatCheckGrid([{ area: "installation", status: "ready" }], FORCE_PIPE)[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("expected installation row");
    expect(row).not.toContain("✓");
    expect(row).toContain("\u001b[32m");
    expect(stripAnsi(row)).toBe("  installation: ready");
  });

  it("CI=true is non-TTY unless FORCE_COLOR", () => {
    expect(resolveCliFormatOptions(CI_TTY)).toMatchObject({ ornaments: false, color: false });
    expect(formatSectionHeader("EXECUTION", CI_TTY)).toBe("EXECUTION");
    expect(resolveCliFormatOptions(CI_FORCE_TTY)).toMatchObject({ ornaments: true, color: true });
    expect(stripAnsi(formatSectionHeader("EXECUTION", CI_FORCE_TTY))).toBe("── EXECUTION ──");
  });

  it("never encodes status as color only", () => {
    const ttyReady = formatCliStatus("ready", TTY);
    const forceFailed = paintCliText("failed", { color: "red", bold: true }, FORCE_PIPE);
    expect(stripAnsi(ttyReady)).toBe("ready");
    expect(stripAnsi(forceFailed)).toBe("failed");
    expect(ttyReady).not.toBe(stripAnsi(ttyReady));
  });
});

describe("cli duration and verdict helpers", () => {
  it("formats human duration and omits zero units", () => {
    expect(formatCliDuration(398_000)).toBe("6m 38s");
    expect(formatCliDuration(45_000)).toBe("45s");
    expect(formatCliDuration(7_200_000)).toBe("2h");
    expect(formatCliDuration(7_325_000)).toBe("2h 2m 5s");
    expect(formatCliDuration(0)).toBe("0s");
  });

  it("composes verdict planes and omits not-requested publication", () => {
    expect(
      formatCliVerdictLine(
        { execution: "succeeded", product: "inconclusive", publication: "failed" },
        PIPE,
      ),
    ).toBe("succeeded · product inconclusive · publication failed");
    expect(
      formatCliVerdictLine(
        { execution: "succeeded", product: "ready", publication: "not-requested" },
        PIPE,
      ),
    ).toBe("succeeded · product ready");
    expect(formatCliVerdictLine({ product: "blocked" }, PIPE)).toBe("blocked");
  });

  it("nests labeled VERDICT rows and ranks the weakest plane for header color", () => {
    expect(
      formatCliVerdictPlaneRows(
        { execution: "succeeded", product: "inconclusive", publication: "failed" },
        PIPE,
      ),
    ).toEqual(["execution succeeded", "product inconclusive", "publication failed"]);
  });
});
