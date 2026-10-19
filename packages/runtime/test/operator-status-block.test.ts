// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChangedFileEvidence } from "../src/impact/contracts.js";
import {
  formatRunSummary,
  projectStatusBlock,
  projectStatusBlockLines,
} from "../src/operator/index.js";
import type { RunSummaryPublicationOutcome } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";

const ANSI_SHAPE = /\u001b\[/u;
const HOST_PATH_SHAPE = /(?:^|[\s`'"])(?:\/(?:Users|home|root|private|tmp|var)\/|[A-Za-z]:\\)/u;

function minimalRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-test-001",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-10T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
    ...overrides,
  };
}

function recordWithChanges(
  files: ChangedFileEvidence[],
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return minimalRunRecord({
    changes: {
      files,
      patch: {
        sha256: "a".repeat(64),
        byteLength: 128,
        lineCount: 8,
        artifactPath: "/private/patches/run-test-001.patch",
        format: "git-diff",
      },
    },
    ...overrides,
  });
}

function findSectionLines(lines: readonly string[], header: string): string[] {
  const start = lines.indexOf(header);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.indexOf("");
  return end === -1 ? rest : rest.slice(0, end);
}

function quietCliLines(record: RunRecord): string[] {
  return formatRunSummary({
    record,
    recordPath: "/private/state/run-test-001.json",
    exitCode: 0,
    repositoryPath: "/tmp/example",
    patchFileStats: [{ path: "docs/guide.md", insertions: 3, deletions: 1 }],
    tty: false,
    noColor: true,
    ci: true,
    quiet: true,
  });
}

describe("operator status-block projector (#364)", () => {
  it("matches CLI --quiet words except host locators on NEXT (no ANSI)", () => {
    const record = recordWithChanges([{ path: "docs/guide.md", status: "modified" }]);
    const cli = quietCliLines(record);
    const projected = projectStatusBlock({
      record,
      patchFileStats: [{ path: "docs/guide.md", insertions: 3, deletions: 1 }],
    });
    const projectedLines = projected.split("\n");

    expect(cli[0]).toBe("VERDICT");
    expect(projectedLines[0]).toBe("VERDICT");
    expect(findSectionLines(projectedLines, "VERDICT")).toEqual(findSectionLines(cli, "VERDICT"));
    expect(findSectionLines(projectedLines, "PATCH")).toEqual(findSectionLines(cli, "PATCH"));
    expect(findSectionLines(cli, "NEXT")).toEqual([
      "  docsfab runs show run-test-001 --state-dir /private/state --json",
      "  Reason: Inspect the saved product evidence and review the local patch before deciding whether to publish.",
    ]);
    expect(findSectionLines(projectedLines, "NEXT")).toEqual([
      "  docsfab runs show run-test-001 --json",
      "  Reason: Inspect the saved product evidence and review the local patch before deciding whether to publish.",
    ]);

    expect(projected).toContain("review-documentation run-test");
    expect(projected).toContain("execution succeeded");
    expect(cli.join("\n")).toContain("review-documentation run-test");
    expect(cli.join("\n")).not.toMatch(ANSI_SHAPE);
    expect(projected).not.toMatch(ANSI_SHAPE);
  });

  it("omits host paths and credentials from the projector string", () => {
    const record = recordWithChanges(
      [
        { path: "docs/guide.md", status: "modified" },
        { path: "/tmp/secret-host-copy.md", status: "modified" },
      ],
      {
        error: "Provider rejected api_key=nvapi-abcdefghijklmnopqrstuvwxyz012345",
      },
    );
    const projected = projectStatusBlock({
      record,
      patchFileStats: [
        { path: "docs/guide.md", insertions: 3, deletions: 1 },
        { path: "/tmp/secret-host-copy.md", insertions: 1, deletions: 0 },
      ],
    });

    expect(projected).not.toMatch(HOST_PATH_SHAPE);
    expect(projected).not.toContain("/private/patches/");
    expect(projected).not.toContain("/tmp/example");
    expect(projected).not.toContain("nvapi-");
    expect(projected).not.toContain("api_key=");
    expect(projected).toContain("docs/guide.md  +3/-1");
    expect(projected).not.toContain("/tmp/secret-host-copy.md");
    expect(projected).toContain("RECORD");
    expect(projected).toContain("run run-test-001");
  });

  it("keeps publication-succeeded NEXT as the merge-request URL", () => {
    const record = recordWithChanges([{ path: "README.md", status: "modified" }]);
    const publication: RunSummaryPublicationOutcome = {
      status: "succeeded",
      mergeRequestUrl: "https://gitlab.example/group/project/-/merge_requests/1",
    };
    const cli = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication,
      tty: false,
      noColor: true,
      ci: true,
    });
    const projected = projectStatusBlockLines({ record, publication });
    expect(findSectionLines(projected, "NEXT")).toEqual(findSectionLines(cli, "NEXT"));
    expect(findSectionLines(projected, "VERDICT")).toEqual(findSectionLines(cli, "VERDICT"));
    expect(projected.join("\n")).not.toMatch(HOST_PATH_SHAPE);
  });

  // Reason literals from `staleRevisionRecovery` in `operator/run-next-action.ts`
  // (the pre-write branch, and the post-write branch without a repository
  // path), pinned as plain strings so a reason swap fails here.
  const PRE_WRITE_STALE_REASON =
    "GitLab's target branch moved before the write started; no run was created. Check this workspace with doctor, then retry, or fetch the merge-request target branch and pass --revision with its new head commit.";
  const POST_WRITE_STALE_REASON_WITHOUT_REPOSITORY =
    "The run base is not an ancestor of GitLab's target branch. Inspect the record, merge its base into the target branch, then republish it with docsfab ship from the run's repository checkout; or start a new run from a commit on the target branch.";

  it.each([
    [
      "post-write",
      [
        "  docsfab runs show run-block-777",
        `  Reason: ${POST_WRITE_STALE_REASON_WITHOUT_REPOSITORY}`,
      ],
    ] as const,
    ["pre-write", ["  docsfab doctor", `  Reason: ${PRE_WRITE_STALE_REASON}`]] as const,
  ])("projects the host-path-free stale-revision NEXT for %s", (phase, expected) => {
    // The projector passes no `repositoryPath`, so this portable seam renders
    // the no-repository branch, unlike the CLI footer.
    //
    // This pins the selector's contract, not a shipped surface: the portable
    // block has no production caller (merge-request notes use the host's own
    // copy in packages/host/src/gitlab-mr-note), and a pre-write refusal
    // produces an error rather than a run record, so the `pre-write` row is
    // contract-only.
    const record = recordWithChanges([{ path: "docs/guide.md", status: "modified" }], {
      id: "run-block-777",
    });
    const publication: RunSummaryPublicationOutcome = {
      status: "failed",
      failureCode: "stale-revision",
      phase,
    };

    const projected = projectStatusBlockLines({ record, publication });
    expect(findSectionLines(projected, "NEXT")).toEqual(expected);
    expect(projected.join("\n")).not.toMatch(HOST_PATH_SHAPE);
    expect(projected.join("\n")).not.toMatch(ANSI_SHAPE);
    expect(projected.join("\n")).not.toContain("--repo");
    expect(projected.join("\n")).not.toContain("Create a new run at");

    // The CLI footer for the same record and phase knows the repository path,
    // so it emits a different NEXT. The two surfaces must not be confused.
    const cli = formatRunSummary({
      record,
      recordPath: "/private/state/run-block-777.json",
      exitCode: 1,
      repositoryPath: "/tmp/example",
      publication,
      tty: false,
      noColor: true,
      ci: true,
    });
    expect(findSectionLines(cli, "NEXT")).not.toEqual(expected);
    expect(findSectionLines(cli, "NEXT").join(" ")).toContain("--repo /tmp/example");
  });

  it("reads a status-block failure with no recorded phase as post-write", () => {
    // Compatibility with publication outcomes saved before the phase field.
    const record = recordWithChanges([{ path: "docs/guide.md", status: "modified" }], {
      id: "run-block-777",
    });
    const publication: RunSummaryPublicationOutcome = {
      status: "failed",
      failureCode: "stale-revision",
    };
    expect(findSectionLines(projectStatusBlockLines({ record, publication }), "NEXT")).toEqual([
      "  docsfab runs show run-block-777",
      `  Reason: ${POST_WRITE_STALE_REASON_WITHOUT_REPOSITORY}`,
    ]);
  });
});
