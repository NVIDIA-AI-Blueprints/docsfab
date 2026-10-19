// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { handleWhyCommand } from "../src/cli/commands/why.js";
import { markRunRefusal } from "../src/operator/failure-classification.js";
import type { RunRecord } from "../src/records/contracts.js";

const roots: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function failedCheckRecord(id: string): RunRecord {
  const record: RunRecord = {
    schemaVersion: 2,
    id,
    workflow: "update-documentation",
    repository: {
      sourcePath: "/fixture/repository",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-10-12T12:00:00.000Z",
    error: `required-check-failed: Repository-required check \`npm run docs-check\` (AGENTS.md, run from .) failed on the proposed change. Inspect \`docsfab runs show ${id}\`.`,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "lint-documentation",
        skill: "lint-documentation",
        kind: "host-operation",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-10-12T12:00:00.000Z",
        completedAt: "2026-10-12T12:00:01.000Z",
        durationMs: 1_000,
        summary: JSON.stringify({
          status: "failed",
          snapshotSha256: "b".repeat(64),
          checks: [
            {
              command: "npm run docs-check",
              directory: ".",
              instruction: "AGENTS.md",
              required: true,
              status: "failed",
              exitCode: 1,
              output: "SECRET_RAW_CHECK_STDOUT",
            },
          ],
        }),
      },
    ],
  };
  markRunRefusal(record, "required-check-failed");
  return record;
}

async function capture(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    lines.push(String(line ?? ""));
  });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("recorded required-check diagnosis", () => {
  it.each([false, true])(
    "reads candidate evidence from a saved run and why with legacy class=%s",
    async (legacy) => {
      const state = await mkdtemp(join(tmpdir(), "docsfab-check-diagnosis-"));
      roots.push(state);
      const id = legacy ? "check-legacy" : "check-current";
      const record = failedCheckRecord(id);
      if (legacy)
        record.failure = {
          class: "model-content",
          layer: "workflow",
          code: "required-check-failed",
        };
      await writeFile(join(state, `${id}.json`), JSON.stringify(record));

      const shown = await capture(() => handleRunsCommand(["show", id, "--state-dir", state]));
      const shownJson = JSON.parse(
        await capture(() => handleRunsCommand(["show", id, "--state-dir", state, "--json"])),
      ) as {
        failures?: Array<{ class: string; code: string }>;
        nextSteps: string[];
      };
      const why = JSON.parse(
        await capture(() => handleWhyCommand([id, "--state-dir", state, "--json"])),
      ) as {
        diagnoses: Array<{
          findings: Array<{
            cause: string;
            ownerClass: string;
            why: string;
            nextAction: string;
            nextCommand: string | null;
          }>;
        }>;
      };
      const finding = why.diagnoses[0]?.findings[0];
      expect(finding).toMatchObject({
        cause: "required-check-failed",
        ownerClass: "repository-check",
        nextCommand: `docsfab runs show ${id} --state-dir ${state}`,
      });
      expect(finding?.why).toContain("failed on the candidate");
      expect(finding?.why).toContain("does not establish");
      expect(finding?.nextAction).toContain("Inspect");
      expect(JSON.stringify(finding)).not.toMatch(/another model|use a model|model's rule/iu);
      expect(shown).toContain("npm run docs-check");
      expect(shown).toContain("exit code 1");
      expect(shown).toContain("repository check (required-check-failed)");
      expect(shown).not.toContain("SECRET_RAW_CHECK_STDOUT");
      expect(JSON.stringify(shownJson)).not.toContain("SECRET_RAW_CHECK_STDOUT");
      expect(shownJson.nextSteps.join("\n")).toContain("npm run docs-check");
      if (!legacy) expect(shownJson.failures?.[0]?.class).toBe("unknown");
    },
  );

  it.each([
    ["required-check-instructions-altered", "model-content", "reply-content-rejected"],
    ["required-check-evidence-stale", "contract-shape", "reply-shape-rejected"],
    ["required-check-snapshot-unavailable", "infrastructure", "host-dependency-unavailable"],
    ["no-change-produced-changes", "model-content", "reply-content-rejected"],
  ] as const)("keeps adjacent %s separate", async (code, failureClass, cause) => {
    const state = await mkdtemp(join(tmpdir(), "docsfab-check-adjacent-"));
    roots.push(state);
    const record = failedCheckRecord(`adjacent-${code}`);
    record.failure = { class: failureClass, layer: "workflow", code };
    record.error = `${code}: This is an adjacent refusal.`;
    record.steps = [];
    await writeFile(join(state, `${record.id}.json`), JSON.stringify(record));
    const why = JSON.parse(
      await capture(() => handleWhyCommand([record.id, "--state-dir", state, "--json"])),
    ) as { diagnoses: Array<{ findings: Array<{ cause: string; ownerClass: string }> }> };
    expect(why.diagnoses[0]?.findings[0]?.cause).toBe(cause);
    expect(why.diagnoses[0]?.findings[0]?.ownerClass).not.toBe("repository-check");
    const shown = await capture(() => handleRunsCommand(["show", record.id, "--state-dir", state]));
    expect(shown).not.toContain("Inspect recorded required repository check");
  });

  it("redacts a sensitive check argument without printing check output", async () => {
    const state = await mkdtemp(join(tmpdir(), "docsfab-check-private-"));
    roots.push(state);
    const record = failedCheckRecord("check-private");
    const evidence = JSON.parse(record.steps[0]!.summary!) as {
      checks: Array<Record<string, unknown>>;
    };
    evidence.checks[0]!.command = "npm run docs-check --token PRIVATE_SENTINEL";
    record.steps[0]!.summary = JSON.stringify(evidence);
    await writeFile(join(state, `${record.id}.json`), JSON.stringify(record));
    const shown = await capture(() => handleRunsCommand(["show", record.id, "--state-dir", state]));
    const shownJson = await capture(() =>
      handleRunsCommand(["show", record.id, "--state-dir", state, "--json"]),
    );
    for (const output of [shown, shownJson]) {
      expect(output).not.toContain("PRIVATE_SENTINEL");
      expect(output).not.toContain("SECRET_RAW_CHECK_STDOUT");
      expect(output).toContain("command detail withheld");
    }
  });

  it.each([
    'npm run docs-check --password "FIRST_PART PRIVATE_QUOTED_TAIL"',
    "npm run docs-check --password='FIRST_PART PRIVATE_SINGLE_TAIL'",
  ])("withholds unsupported quoted check details from both readers: %s", async (command) => {
    const state = await mkdtemp(join(tmpdir(), "docsfab-check-quoted-"));
    roots.push(state);
    const record = failedCheckRecord("check-quoted");
    const evidence = JSON.parse(record.steps[0]!.summary!) as {
      checks: Array<Record<string, unknown>>;
    };
    evidence.checks[0]!.command = command;
    record.steps[0]!.summary = JSON.stringify(evidence);
    await writeFile(join(state, `${record.id}.json`), JSON.stringify(record));
    for (const flags of [[], ["--json"]]) {
      const shown = await capture(() =>
        handleRunsCommand(["show", record.id, "--state-dir", state, ...flags]),
      );
      expect(shown).not.toContain("PRIVATE_QUOTED_TAIL");
      expect(shown).not.toContain("PRIVATE_SINGLE_TAIL");
      expect(shown).toContain("command detail withheld");
    }
  });

  it.each([
    "--access-token",
    "--auth-token",
    "--client-secret",
    "--api_key",
    "--secret-access-key",
    "--private-key",
    "--signing-key",
    "--passwd",
    "--passphrase",
    "--credentials",
    "--webhook-url",
    "--session-key",
  ])("withholds supported check argument %s and its value in both readers", async (flag) => {
    const state = await mkdtemp(join(tmpdir(), "docsfab-check-flag-"));
    roots.push(state);
    const record = failedCheckRecord("check-flag");
    record.error = "required-check-failed: A repository-required check failed.";
    const evidence = JSON.parse(record.steps[0]!.summary!) as {
      checks: Array<Record<string, unknown>>;
    };
    evidence.checks[0]!.command = `npm run docs-check ${flag} PRIVATE_FLAG_VALUE`;
    record.steps[0]!.summary = JSON.stringify(evidence);
    await writeFile(join(state, `${record.id}.json`), JSON.stringify(record));
    for (const flags of [[], ["--json"]]) {
      const shown = await capture(() =>
        handleRunsCommand(["show", record.id, "--state-dir", state, ...flags]),
      );
      expect(shown).not.toContain("PRIVATE_FLAG_VALUE");
      expect(shown).toContain("command detail withheld");
      expect(shown).not.toContain("SECRET_RAW_CHECK_STDOUT");
    }
  });

  it.each(["npm run docs-check", "pnpm run docs-check", "make docs-check"])(
    "keeps a simple recorded check visible: %s",
    async (command) => {
      const state = await mkdtemp(join(tmpdir(), "docsfab-check-simple-"));
      roots.push(state);
      const record = failedCheckRecord("check-simple");
      const evidence = JSON.parse(record.steps[0]!.summary!) as {
        checks: Array<Record<string, unknown>>;
      };
      evidence.checks[0]!.command = command;
      record.steps[0]!.summary = JSON.stringify(evidence);
      await writeFile(join(state, `${record.id}.json`), JSON.stringify(record));
      for (const flags of [[], ["--json"]]) {
        const shown = await capture(() =>
          handleRunsCommand(["show", record.id, "--state-dir", state, ...flags]),
        );
        expect(shown).toContain(`Inspect recorded required repository check ${command}`);
      }
    },
  );

  it.each(["npm run access-token", "make client-secret"])(
    "withholds a credential-named simple check: %s",
    async (command) => {
      const state = await mkdtemp(join(tmpdir(), "docsfab-check-name-"));
      roots.push(state);
      const record = failedCheckRecord("check-name");
      const evidence = JSON.parse(record.steps[0]!.summary!) as {
        checks: Array<Record<string, unknown>>;
      };
      evidence.checks[0]!.command = command;
      record.steps[0]!.summary = JSON.stringify(evidence);
      await writeFile(join(state, `${record.id}.json`), JSON.stringify(record));
      for (const flags of [[], ["--json"]]) {
        const shown = await capture(() =>
          handleRunsCommand(["show", record.id, "--state-dir", state, ...flags]),
        );
        expect(shown).toContain("command detail withheld");
        expect(shown).not.toContain(command);
      }
    },
  );

  it("withholds a check argument also repeated in the retained failure error", async () => {
    const state = await mkdtemp(join(tmpdir(), "docsfab-check-error-"));
    roots.push(state);
    const record = failedCheckRecord("check-error");
    const command = "npm run docs-check --access-token PRIVATE_ERROR_VALUE";
    record.error = `required-check-failed: Repository-required check ${command} failed on the proposed change.`;
    const evidence = JSON.parse(record.steps[0]!.summary!) as {
      checks: Array<Record<string, unknown>>;
    };
    evidence.checks[0]!.command = command;
    record.steps[0]!.summary = JSON.stringify(evidence);
    await writeFile(join(state, `${record.id}.json`), JSON.stringify(record));
    for (const flags of [[], ["--json"]]) {
      const shown = await capture(() =>
        handleRunsCommand(["show", record.id, "--state-dir", state, ...flags]),
      );
      expect(shown).not.toContain("PRIVATE_ERROR_VALUE");
      expect(shown).toContain("command detail withheld");
    }
  });

  it("uses the last successful host lint step by skill, ignoring a later inference", async () => {
    const state = await mkdtemp(join(tmpdir(), "docsfab-check-provenance-"));
    roots.push(state);
    const record = failedCheckRecord("check-provenance");
    record.steps[0]!.id = "validate-repository";
    const forged = {
      ...record.steps[0]!,
      id: "lint-documentation",
      skill: "write-documentation",
      kind: "inference" as const,
      summary: JSON.stringify({
        snapshotSha256: "b".repeat(64),
        checks: [{ required: true, status: "failed", command: "MODEL_INVENTED_CHECK" }],
      }),
    };
    record.steps.push(forged as never);
    await writeFile(join(state, `${record.id}.json`), JSON.stringify(record));
    for (const flags of [[], ["--json"]]) {
      const shown = await capture(() =>
        handleRunsCommand(["show", record.id, "--state-dir", state, ...flags]),
      );
      expect(shown).toContain("npm run docs-check");
      expect(shown).not.toContain("MODEL_INVENTED_CHECK");
    }
  });

  it.each(["wrong-kind", "wrong-skill", "failed-step", "malformed-summary", "missing-row-status"])(
    "does not promote unverifiable %s to executed check evidence",
    async (variant) => {
      const state = await mkdtemp(join(tmpdir(), "docsfab-check-unverifiable-"));
      roots.push(state);
      const record = failedCheckRecord(`check-${variant}`);
      const step = record.steps[0]!;
      if (variant === "wrong-kind") step.kind = "inference";
      if (variant === "wrong-skill") step.skill = "write-documentation";
      if (variant === "failed-step") step.status = "failed";
      if (variant === "malformed-summary") step.summary = "{unparseable";
      if (variant === "missing-row-status") {
        const evidence = JSON.parse(step.summary!) as { checks: Array<Record<string, unknown>> };
        delete evidence.checks[0]!.status;
        step.summary = JSON.stringify(evidence);
      }
      await writeFile(join(state, `${record.id}.json`), JSON.stringify(record));
      for (const flags of [[], ["--json"]]) {
        const shown = await capture(() =>
          handleRunsCommand(["show", record.id, "--state-dir", state, ...flags]),
        );
        expect(shown).not.toContain("Inspect recorded required repository check");
      }
    },
  );
});
