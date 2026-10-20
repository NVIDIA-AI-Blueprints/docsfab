// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { runIssueLifecycleCli } from "../src/roadmap/issue-cli.js";

const enabled = process.env.DOCSFAB_RUN_GITLAB_ISSUE_LIVE === "1";

describe("disposable GitLab issue lifecycle (explicit live opt-in)", () => {
  it.runIf(enabled && process.env.DOCSFAB_GITLAB_LIVE_APPLY === "1")(
    "creates, updates, links, and safely replays an operator-authorized disposable plan",
    async () => {
      const args = liveArgs("DOCSFAB_GITLAB_LIVE");
      const output: string[] = [];
      await runIssueLifecycleCli(["apply", ...args], {
        cwd: process.cwd(),
        log: (line) => output.push(line),
      });
      await runIssueLifecycleCli(["apply", ...args], {
        cwd: process.cwd(),
        log: (line) => output.push(line),
      });
      expect(output.at(-1)).toContain("complete");
    },
    120_000,
  );

  it.runIf(enabled && process.env.DOCSFAB_GITLAB_LIVE_CLOSE === "1")(
    "closes disposable issues only through a separately operator-authorized closure plan",
    async () => {
      const output: string[] = [];
      await runIssueLifecycleCli(["apply", ...liveArgs("DOCSFAB_GITLAB_LIVE_CLOSE")], {
        cwd: process.cwd(),
        log: (line) => output.push(line),
      });
      expect(output.at(-1)).toContain("complete");
    },
    120_000,
  );
});

function liveArgs(prefix: string): string[] {
  const value = (suffix: string): string => {
    const result = process.env[`${prefix}_${suffix}`];
    if (!result) throw new Error(`Live harness requires ${prefix}_${suffix}.`);
    return result;
  };
  return [
    "--ledger",
    value("LEDGER"),
    "--plan",
    value("PLAN"),
    "--material",
    value("MATERIAL"),
    "--authorization",
    value("AUTHORIZATION"),
    "--receipt",
    value("RECEIPT"),
    "--confirm-plan-sha256",
    value("PLAN_SHA256"),
    "--confirm-authorization-sha256",
    value("AUTHORIZATION_SHA256"),
    "--json",
  ];
}
