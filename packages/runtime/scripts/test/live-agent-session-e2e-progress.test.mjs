// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { terminalOutputWithoutElapsedProgress } from "../live-agent-session-e2e-progress.mjs";

describe("installed live-agent terminal progress", () => {
  it("does not count elapsed spinner redraws or split spinner chunks as progress", () => {
    const baseline = "[Done] earlier step (1s)\n";
    const initial = `${baseline}\r\u001b[2K[Working] Running workflow (0s)`;
    const partial = `${baseline}\r\u001b[2K[Work`;
    const redraw = `${baseline}\r\u001b[2K[Working] Running workflow (62s)`;

    expect(terminalOutputWithoutElapsedProgress(partial)).toBe(
      terminalOutputWithoutElapsedProgress(baseline),
    );
    expect(terminalOutputWithoutElapsedProgress(redraw)).toBe(
      terminalOutputWithoutElapsedProgress(initial),
    );
    expect(terminalOutputWithoutElapsedProgress(`${redraw}\r\u001b[`)).toBe(
      terminalOutputWithoutElapsedProgress(initial),
    );
  });

  it("does not count cumulative redraw frames of the same activity", () => {
    const first = "\r\u001b[2K[Working] Running workflow (0s)";
    const accumulated = `${first}\r\u001b[2K[Working] Running workflow (1s)\r\u001b[2K[Working] Running workflow (62s)`;

    expect(terminalOutputWithoutElapsedProgress(accumulated)).toBe(
      terminalOutputWithoutElapsedProgress(first),
    );
  });

  it("counts completed stages and approval output without swallowing nearby text", () => {
    const working = "[Working] update-documentation · step 2/3: quality (25s)";
    const completed = `${working}\r\u001b[2K[Done] update-documentation · step 2/3: quality (28s)\n`;
    const approval = `${completed}Publish this saved run? [y/N] `;

    expect(terminalOutputWithoutElapsedProgress(completed)).not.toBe(
      terminalOutputWithoutElapsedProgress(working),
    );
    expect(terminalOutputWithoutElapsedProgress(approval)).not.toBe(
      terminalOutputWithoutElapsedProgress(completed),
    );
    expect(terminalOutputWithoutElapsedProgress(`${working}\nsubstantive result\n`)).toContain(
      "substantive result",
    );
  });

  it("counts a complete new step label but ignores truncated or incomplete redraws", () => {
    const first = "[Working] update-documentation · step 1/3: edit (3s)";
    const next = `${first}\r\u001b[2K[Working] update-documentation · step 2/3: quality (0s)`;
    const incomplete = `${first}\r\u001b[2K[Working] update-documentation · step 2/3: qual`;

    expect(terminalOutputWithoutElapsedProgress(incomplete)).toBe(
      terminalOutputWithoutElapsedProgress(first),
    );
    expect(terminalOutputWithoutElapsedProgress(next)).not.toBe(
      terminalOutputWithoutElapsedProgress(first),
    );
    expect(terminalOutputWithoutElapsedProgress(`${first}\r\u001b[2K[Working] upda~ (10s)`)).toBe(
      terminalOutputWithoutElapsedProgress(first),
    );
  });
});
