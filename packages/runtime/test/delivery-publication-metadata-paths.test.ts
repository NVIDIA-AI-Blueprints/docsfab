// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDocsFabPublicationMetadata,
  createCompositionPublicationBinding,
  hasExactDocsFabPublicationMetadata,
  hasExactDocsFabPublicationProvenance,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  type LocalUserPublicationPlanV1,
} from "../src/delivery/index.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import type { RunRecord } from "../src/records/contracts.js";

const COMMIT = "a".repeat(40);

// GitLab 17.7.7-ee's configured default from
// gitlab-org/gitlab/config/gitlab.yml.example. Its closing extractor expands
// `%{issue_ref}` with HTTP_LINK_PATTERN and Issue.reference_pattern, then scans
// the raw description, including text inside Markdown code spans.
const GITLAB_HTTP_LINK = String.raw`((http|https):\/\/[^\s>]{1,300})(?<!\?|!|\.|,|:)`;
const GITLAB_SHORT_ISSUE_REFERENCE = String.raw`(?:(?:(?<![A-Za-z0-9_.])\/?[\w.\-]+(?:\/[\w.\-]+)*)?#|GL-)\d{1,20}(?:\+s?)?(?=\W|$)`;
const GITLAB_ISSUE_REFERENCE = String.raw`(?:${GITLAB_HTTP_LINK}|${GITLAB_SHORT_ISSUE_REFERENCE})`;
const GITLAB_CLOSING_PATTERN = new RegExp(
  String.raw`\b((?:[Cc]los(?:e[sd]?|ing)|\b[Ff]ix(?:e[sd]|ing)?|\b[Rr]esolv(?:e[sd]?|ing)|\b[Ii]mplement(?:s|ed|ing)?)(:?) +(?:(?:issues? +)?${GITLAB_ISSUE_REFERENCE}(?:(?:, *| +and +)?)|([A-Z][A-Z0-9_]+-\d+))+)`,
  "u",
);

const GITLAB_CLOSING_VERBS = [
  "Close",
  "Closes",
  "Closed",
  "Closing",
  "Fix",
  "Fixes",
  "Fixed",
  "Fixing",
  "Resolve",
  "Resolves",
  "Resolved",
  "Resolving",
  "Implement",
  "Implements",
  "Implemented",
  "Implementing",
];

describe("publication metadata changed paths", () => {
  it.each(GITLAB_CLOSING_VERBS)(
    "withholds paths containing GitLab's %s closing form from the final description",
    (verb) => {
      const reference = verb === "Resolving" ? "group/project#42" : "#42";
      const statement = `${verb} ${reference}`;
      const description = buildMetadata([`docs/${statement}.md`]).mergeRequestDescription;

      expect(GITLAB_CLOSING_PATTERN.test(statement)).toBe(true);
      expect(GITLAB_CLOSING_PATTERN.test(description)).toBe(false);
      expect(description).toContain("1 changed path is not shown here");
      expect(description).toContain("`docsfab runs show run-1`");
    },
  );

  it("ports GitLab's optional issue separators and HTTP-link punctuation boundary", () => {
    expect(GITLAB_CLOSING_PATTERN.test("Closes #1, #2 and group/project#3")).toBe(true);
    expect(
      GITLAB_CLOSING_PATTERN.test("Closes https://gitlab.example.test/group/project/-/issues/3"),
    ).toBe(true);
    const punctuationMatch = GITLAB_CLOSING_PATTERN.exec(
      "Closes https://gitlab.example.test/group/project/-/issues/3.",
    );
    expect(punctuationMatch?.[0]).toBe(
      "Closes https://gitlab.example.test/group/project/-/issues/3",
    );
  });

  it("keeps GitLab closing references out of the final description and retains ordinary paths and markers", () => {
    const paths = [
      "docs/Closes #1.md",
      "docs/fix #12.md",
      "docs/Resolves group/project#5.md",
      "docs/release notes.md",
      "docs/issues/guide.md",
      "docs/docsfab-publication-provenance.md",
      "docs/docsfab-composition-execution.md",
    ];
    const metadata = buildMetadata(paths);
    const { mergeRequestDescription: description } = metadata;

    expect(GITLAB_CLOSING_PATTERN.test("Closes #1")).toBe(true);
    expect(GITLAB_CLOSING_PATTERN.test("Fix #12")).toBe(true);
    expect(GITLAB_CLOSING_PATTERN.test("Resolves group/project#5")).toBe(true);
    expect(GITLAB_CLOSING_PATTERN.test(description)).toBe(false);
    expect(description).toContain("3 changed paths are not shown here");
    expect(description).toContain("`docsfab runs show run-1`");
    expect(description).toContain("  - `docs/release notes.md`");
    expect(description).toContain("  - `docs/issues/guide.md`");
    expect(description).not.toContain("docs/Closes #1.md");
    expect(description).not.toContain("docs/fix #12.md");
    expect(description).not.toContain("docs/Resolves group/project#5.md");

    expect(description).toContain("  - `docs/docsfab-publication-provenance.md`");
    expect(description).toContain("  - `docs/docsfab-composition-execution.md`");
    expect(
      hasExactDocsFabPublicationProvenance(description, metadata.mergeRequestProvenanceMarker),
    ).toBe(true);
    expect(
      hasExactDocsFabPublicationMetadata(metadata.mergeRequestTitle, description, metadata),
    ).toBe(true);
  });

  it("keeps every omitted issue-reference path available through runs show", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-publication-paths-"));
    const stateDirectory = join(root, "runs");
    await mkdir(stateDirectory, { recursive: true });
    const paths = ["docs/Closes #1.md", "docs/fix #12.md", "docs/Resolves group/project#5.md"];
    const record = minimalRunRecord({
      id: "run-publication-paths",
      workflow: "create-documentation",
      changes: {
        files: paths.map((path) => ({ path, status: "added" as const })),
      },
    });
    try {
      await writeFile(join(stateDirectory, `${record.id}.json`), `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
      const shown = await captureConsole(() =>
        handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
      );
      for (const path of paths) expect(shown).toContain(path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function minimalRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-publication-paths",
    workflow: "create-documentation",
    repository: {
      sourcePath: "/workspace",
      requestedRevision: "HEAD",
      revision: COMMIT,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-10T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    tools: { attempted: 0, succeeded: 0, failed: 0, denied: 0 },
    steps: [],
    ...overrides,
  } as RunRecord;
}

async function captureConsole(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => lines.push(String(message ?? ""));
  try {
    await action();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

function buildMetadata(paths: readonly string[]) {
  return buildDocsFabPublicationMetadata({
    plan: plan(paths.length),
    workflowOutcome: "Update the publication guide",
    changedPaths: paths,
    compositionExecution: createCompositionPublicationBinding({
      compositionId: "composition-1",
      evidenceSha256: "b".repeat(64),
      aggregateSha256: "c".repeat(64),
    }),
  });
}

function plan(changedFileCount: number): LocalUserPublicationPlanV1 {
  const candidate = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "run-1", recordSha256: "d".repeat(64) },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "ssh" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: COMMIT,
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/run-1",
    patch: {
      format: "git-diff",
      sha256: createHash("sha256").update("patch").digest("hex"),
      byteLength: 5,
      changedFileCount,
    },
    validationCommand: "npm run check",
    mergeRequest: { draft: true },
    fallback: { mode: "patch-only", preserved: true },
    checks: {
      repository: "passed",
      remote: "passed",
      revision: "current",
      gitIdentity: "configured",
      gitlabAuthentication: "authenticated",
      pushAccess: "allowed",
      sourceBranch: "unprotected",
    },
  } as const;
  return {
    ...candidate,
    sha256: localUserPublicationPlanSha256(candidate as never),
  };
}
