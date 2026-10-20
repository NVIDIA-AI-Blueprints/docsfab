// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { candidateSourceManifestSha256V1 } from "../src/candidate-source-manifest.js";
import {
  CANDIDATE_REVIEW_MANIFEST_FINDING_LOCATION,
  CandidateReviewEvidenceError,
  type HostRuntimeCandidateReviewV1,
  assembleCandidateReviewEvidenceV1,
} from "../src/host-invoker/candidate-review-evidence.js";
import { collectCredentialFindingsAsync } from "../src/security/credential-shape-findings.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import {
  clearPlantedCredential,
  plainConfiguredCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

/**
 * Candidate review source evidence under the owner decision on #1807: source
 * that only looks like it carries a credential is reviewed and recorded, and
 * only DocsFab's own configured credential refuses the evidence.
 */

const roots = temporaryRoots();

/** Token-shaped text, assembled at run time so no source line holds one. */
const tokenShape = (fill: string): string => ["glpat", fill.repeat(20)].join("-");

const manifestHooks = {
  fail(code: string): never {
    throw new Error(code);
  },
  rejectCredentials(): void {},
};

/**
 * A repository whose source change at `path` goes from `before` to `after`,
 * with a candidate documentation commit on top, and the candidate binding the
 * evidence assembler checks.
 */
async function candidateFixture(path: string, before: string, after: string) {
  const repository = await roots.create("docsfab-candidate-review-");
  await initFixtureRepo(repository, { "docs/guide.md": "# Guide\n", [path]: before });
  const sourceBaseRevision = await commitFixture(repository, "base source");
  await mkdir(dirname(join(repository, path)), { recursive: true });
  await writeFile(join(repository, path), after);
  const sourceHeadRevision = await commitFixture(repository, "source change");
  const sourceHeadTreeObjectId = await git(repository, ["rev-parse", "HEAD^{tree}"]);
  await writeFile(join(repository, "docs", "guide.md"), "# Candidate guide\n");
  const reviewCommitObjectId = await commitFixture(repository, "candidate");
  const candidateTreeObjectId = await git(repository, ["rev-parse", "HEAD^{tree}"]);
  const candidate = {
    sourceBaseRevision,
    sourceHeadRevision,
    sourceHeadTreeObjectId,
    sourceManifestSha256: candidateSourceManifestSha256V1(
      [{ path, status: "modified", previousPath: null }],
      manifestHooks,
    ),
    reviewCommitObjectId,
    candidateTreeObjectId,
  } as unknown as HostRuntimeCandidateReviewV1;
  return { repository, candidate };
}

async function refusalCode(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof CandidateReviewEvidenceError) return error.code;
    throw error;
  }
  return "assembled";
}

describe("candidate review source evidence and credential-like content (#1807)", () => {
  it("reviews source that only looks like it carries a token and records each side without the text", async () => {
    const before = `export const sample = "${tokenShape("A")}";\n`;
    const after = `export const sample = "${tokenShape("B")}";\n`;
    const { repository, candidate } = await candidateFixture("src/feature.ts", before, after);

    const { result, findings } = await collectCredentialFindingsAsync(() =>
      assembleCandidateReviewEvidenceV1({ workspacePath: repository, candidate }),
    );

    expect(result.changes.map((change) => [change.before?.content, change.after?.content])).toEqual(
      [[before, after]],
    );
    expect(findings).toEqual([
      {
        code: "credential-like-content",
        location: "candidate-review:source-base",
        rule: "credential.gitlab-token",
      },
      {
        code: "credential-like-content",
        location: "candidate-review:source-head",
        rule: "credential.gitlab-token",
      },
    ]);
    const recorded = JSON.stringify(findings);
    expect(recorded).not.toContain(tokenShape("A"));
    expect(recorded).not.toContain(tokenShape("B"));
    expect(recorded).not.toContain("src/feature.ts");
  });

  it("refuses source carrying DocsFab's own configured credential, which looks like no credential", async () => {
    const planted = plainConfiguredCredential("candidate");
    const { repository, candidate } = await candidateFixture(
      "src/feature.ts",
      "export const sample = 1;\n",
      `export const sample = "${planted}";\n`,
    );
    plantConfiguredCredential(planted);
    try {
      expect(
        await refusalCode(() =>
          assembleCandidateReviewEvidenceV1({ workspacePath: repository, candidate }),
        ),
      ).toBe("credential-material");
    } finally {
      clearPlantedCredential();
    }
    // The same bytes are reviewed once the value is not a configured credential.
    expect(
      await refusalCode(() =>
        assembleCandidateReviewEvidenceV1({ workspacePath: repository, candidate }),
      ),
    ).toBe("assembled");
  });

  it("reviews a changed path that only looks like a credential and records it without the path", async () => {
    const path = `src/${tokenShape("C")}.ts`;
    const { repository, candidate } = await candidateFixture(
      path,
      "export const sample = 1;\n",
      "export const sample = 2;\n",
    );

    const { result, findings } = await collectCredentialFindingsAsync(() =>
      assembleCandidateReviewEvidenceV1({ workspacePath: repository, candidate }),
    );

    expect(result.changes.map((change) => change.path)).toEqual([path]);
    expect(findings).toEqual([
      {
        code: "credential-like-content",
        location: CANDIDATE_REVIEW_MANIFEST_FINDING_LOCATION,
        rule: "credential.gitlab-token",
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain(tokenShape("C"));
  });

  it("refuses a changed path carrying DocsFab's own configured credential", async () => {
    const planted = plainConfiguredCredential("manifest");
    const { repository, candidate } = await candidateFixture(
      `src/${planted}.ts`,
      "export const sample = 1;\n",
      "export const sample = 2;\n",
    );
    plantConfiguredCredential(planted);
    try {
      expect(
        await refusalCode(() =>
          assembleCandidateReviewEvidenceV1({ workspacePath: repository, candidate }),
        ),
      ).toBe("credential-material");
    } finally {
      clearPlantedCredential();
    }
  });
});
