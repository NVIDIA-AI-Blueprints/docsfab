// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyBoundedLinkRepair,
  boundedLinkRepairPlanDigest,
  BoundedLinkRepairError,
  prepareBoundedLinkRepairApprovalGrant,
  prepareBoundedLinkRepairCapability,
  type ApprovedBoundedLinkRepairPlan,
  type BoundedLinkRepairApprovalGrant,
  type BoundedLinkRepairCapability,
} from "../src/impact/repair.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

const NOW = new Date("2026-08-03T16:00:00.000Z");
const ORIGINAL = "# Guide\n\nSee [installation](docs/old.md).\n";
const REPAIRED = "# Guide\n\nSee [installation](docs/new.md).\n";
const APPLICABLE_PATCH = [
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1,3 +1,3 @@",
  " # Guide",
  " ",
  "-See [installation](docs/old.md).",
  "+See [installation](docs/new.md).",
  "",
].join("\n");
const ALLOWED_APPROVERS = ["maintainer:example"] as const;

let testRoot: string;
let source: string;
let workspace: RepositoryWorkspace;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "docsfab-impact-repair-"));
  source = join(testRoot, "source");
  await mkdir(join(source, "docs"), { recursive: true });
  await writeFile(join(source, "docs/guide.md"), ORIGINAL, { mode: 0o640 });
  await initFixtureRepo(source);
  await commitFixture(source);
  workspace = await prepareRepositoryWorkspace(source, "HEAD");
});

afterEach(async () => {
  await workspace?.dispose().catch(() => undefined);
  await rm(testRoot, { recursive: true, force: true });
});

describe("bounded link repair", () => {
  it("atomically repairs one approved existing-file link only in the disposable workspace", async () => {
    const target = join(workspace.path, "docs/guide.md");
    const before = await lstat(target);
    const capability = await authorizedCapability();

    const summary = await applyBoundedLinkRepair({
      workspace,
      capability,
      evaluationTime: NOW,
    });

    const after = await lstat(target);
    expect(await readFile(target, "utf8")).toBe(REPAIRED);
    expect(await readFile(join(source, "docs/guide.md"), "utf8")).toBe(ORIGINAL);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    expect(summary).toMatchObject({
      schemaVersion: 1,
      operation: "bounded-link-repair",
      repositoryRevision: workspace.revision,
      outputPath: "docs/guide.md",
      preimage: {
        sha256: sha(ORIGINAL),
        byteLength: Buffer.byteLength(ORIGINAL),
        mode: before.mode & 0o7777,
      },
      postimage: {
        sha256: sha(REPAIRED),
        byteLength: Buffer.byteLength(REPAIRED),
        mode: before.mode & 0o7777,
      },
      patch: { sha256: sha(APPLICABLE_PATCH), byteLength: Buffer.byteLength(APPLICABLE_PATCH) },
      delivery: { mode: "patch-only", mayMerge: false, mayPublish: false },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(workspace.path);
    expect(serialized).not.toContain(source);
    expect(serialized).not.toContain("docs/old.md");
    expect(serialized).not.toContain("docs/new.md");
    const patchPath = join(testRoot, "bounded-link-repair.patch");
    await writeFile(patchPath, APPLICABLE_PATCH);
    await git(source, ["apply", "--check", patchPath]);
    expect(await readFile(join(source, "docs/guide.md"), "utf8")).toBe(ORIGINAL);
  });

  it("persists a reviewable patch that applies cleanly while the source stays unchanged", async () => {
    const sourceStatus = await git(source, ["status", "--porcelain=v1"]);
    const collector = await GitPatchEvidenceCollector.create(
      workspace.path,
      join(testRoot, "evidence"),
    );
    let patchPath = "";
    try {
      const capability = await authorizedCapability();
      await applyBoundedLinkRepair({ workspace, capability, evaluationTime: NOW });
      const evidence = await collector.capture({
        runId: "impact-link-repair",
        repository: {
          sourcePath: workspace.sourcePath,
          requestedRevision: workspace.requestedRevision,
          revision: workspace.revision,
        },
        workspacePath: workspace.path,
        persistPatch: true,
      });
      patchPath = evidence.patch?.artifactPath ?? "";
      expect(evidence.files).toEqual([
        {
          path: "docs/guide.md",
          status: "modified",
        },
      ]);
    } finally {
      await collector.dispose();
    }

    expect(await git(source, ["status", "--porcelain=v1"])).toBe(sourceStatus);
    expect(await readFile(join(source, "docs/guide.md"), "utf8")).toBe(ORIGINAL);
    const checkout = join(testRoot, "fresh-checkout");
    await git(testRoot, ["clone", "--quiet", source, checkout]);
    await git(checkout, ["apply", "--check", patchPath]);
    await git(checkout, ["apply", patchPath]);
    expect(await readFile(join(checkout, "docs/guide.md"), "utf8")).toBe(REPAIRED);
  });

  it("rejects forged capabilities and capabilities bound to another workspace", async () => {
    const capability = await authorizedCapability();
    const forged = { ...capability } as BoundedLinkRepairCapability;
    const other = await prepareRepositoryWorkspace(source, "HEAD");
    try {
      await expectCode(
        applyBoundedLinkRepair({
          workspace,
          capability: forged,
          evaluationTime: NOW,
        }),
        "invalid-capability",
      );
      await expectCode(
        applyBoundedLinkRepair({
          workspace: other,
          capability,
          evaluationTime: NOW,
        }),
        "invalid-capability",
      );
    } finally {
      await other.dispose();
    }
  });

  it("rejects forged grants and self-attested approvers outside the host allowlist", async () => {
    const repairPlan = plan();
    const forged = {
      planDigest: repairPlan.digest,
      approvedBy: repairPlan.approval.approvedBy,
    } as BoundedLinkRepairApprovalGrant;
    await expectCode(
      prepareBoundedLinkRepairCapability({
        workspace,
        approval: forged,
        evaluationTime: NOW,
      }),
      "invalid-approval",
    );

    const selfAttested = plan({
      approval: {
        status: "approved",
        requirement: "maintainer",
        approvedBy: "maintainer:attacker",
        approvedAt: "2026-08-03T15:00:00.000Z",
      },
    });
    expect(() =>
      prepareBoundedLinkRepairApprovalGrant({
        plan: selfAttested,
        allowedApprovers: ALLOWED_APPROVERS,
        evaluationTime: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-approval" }));
  });

  it.each([
    ["path escape", "../guide.md", "docs/new.md"],
    ["NUL path", "docs/guide.md\0", "docs/new.md"],
    ["absolute link", "docs/guide.md", "/etc/passwd"],
    ["link traversal", "docs/guide.md", "../outside.md"],
    ["remote link", "docs/guide.md", "https://example.test/steal"],
  ])("rejects %s before capability creation", async (_name, outputPath, newLink) => {
    await expectCode(
      capabilityForPlan(plan({ outputPath, newLink })),
      outputPath === "docs/guide.md" ? "unsafe-link" : "unsafe-path",
    );
  });

  it("rejects symlink components without following them", async () => {
    const outside = join(testRoot, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "guide.md"), ORIGINAL);
    await rm(join(workspace.path, "docs"), { recursive: true });
    await symlink(outside, join(workspace.path, "docs"), "dir");

    await expectCode(capabilityForPlan(plan()), "unsafe-path");
    expect(await readFile(join(outside, "guide.md"), "utf8")).toBe(ORIGINAL);
  });

  it("rejects stale preimages both before sealing and before applying", async () => {
    await expectCode(capabilityForPlan(plan({ preimageSha256: "f".repeat(64) })), "stale-preimage");

    const capability = await authorizedCapability();
    await writeFile(join(workspace.path, "docs/guide.md"), `${ORIGINAL}\nchanged\n`);
    await expectCode(
      applyBoundedLinkRepair({
        workspace,
        capability,
        evaluationTime: NOW,
      }),
      "race-detected",
    );
  });

  it.each([
    ["missing", "# Guide\n\nNo relevant link.\n", "old-link-missing"],
    ["ambiguous", "[one](docs/old.md) and [two](docs/old.md)\n", "old-link-ambiguous"],
  ] as const)("rejects a %s old link", async (_name, content, code) => {
    await writeFile(join(workspace.path, "docs/guide.md"), content);
    await expectCode(capabilityForPlan(plan({ preimageSha256: sha(content) })), code);
  });

  it("detects concurrent identity and mode changes before replacement", async () => {
    const capability = await authorizedCapability();
    const target = join(workspace.path, "docs/guide.md");
    const moved = join(workspace.path, "docs/guide-before-race.md");
    await expectCode(
      applyBoundedLinkRepair(
        {
          workspace,
          capability,
          evaluationTime: NOW,
        },
        {
          beforeAtomicReplace: async () => {
            await rename(target, moved);
            await writeFile(target, "maintainer replacement\n");
          },
        },
      ),
      "race-detected",
    );
    expect(await readFile(target, "utf8")).toBe("maintainer replacement\n");
    expect(await readFile(moved, "utf8")).toBe(ORIGINAL);

    await rm(target);
    await rename(moved, target);
    const modeCapability = await authorizedCapability();
    await expectCode(
      applyBoundedLinkRepair(
        {
          workspace,
          capability: modeCapability,
          evaluationTime: NOW,
        },
        {
          beforeAtomicReplace: () => chmod(target, 0o600),
        },
      ),
      "race-detected",
    );
    expect(await readFile(target, "utf8")).toBe(ORIGINAL);
  });

  it("rejects a parent-directory swap before commit and invalidates the workspace", async () => {
    const capability = await authorizedCapability();
    const docs = join(workspace.path, "docs");
    const movedDocs = join(testRoot, "docs-before-commit-race");

    await expectCode(
      applyBoundedLinkRepair(
        {
          workspace,
          capability,
          evaluationTime: NOW,
        },
        {
          beforeAtomicReplace: async () => {
            await rename(docs, movedDocs);
            await symlink(movedDocs, docs, "dir");
          },
        },
      ),
      "race-detected",
    );

    expect(await readFile(join(movedDocs, "guide.md"), "utf8")).toBe(ORIGINAL);
    expect(await readFile(join(source, "docs/guide.md"), "utf8")).toBe(ORIGINAL);
    await expect(lstat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores exact original bytes and mode when post-repair validation fails", async () => {
    const capability = await authorizedCapability();
    const target = join(workspace.path, "docs/guide.md");
    const before = await lstat(target);

    await expectCode(
      applyBoundedLinkRepair(
        {
          workspace,
          capability,
          evaluationTime: NOW,
        },
        {
          validateAfterRepair: async () => {
            expect(await readFile(target, "utf8")).toBe(REPAIRED);
            throw new Error("repository check failed");
          },
        },
      ),
      "validation-failed",
    );

    const after = await lstat(target);
    expect(await readFile(target)).toEqual(Buffer.from(ORIGINAL));
    expect(after.mode).toBe(before.mode);
  });

  it("refuses rollback through a swapped parent and invalidates the workspace", async () => {
    const capability = await authorizedCapability();
    const docs = join(workspace.path, "docs");
    const movedDocs = join(testRoot, "docs-after-install-race");

    await expectCode(
      applyBoundedLinkRepair(
        {
          workspace,
          capability,
          evaluationTime: NOW,
        },
        {
          validateAfterRepair: async () => {
            expect(await readFile(join(docs, "guide.md"), "utf8")).toBe(REPAIRED);
            await rename(docs, movedDocs);
            await symlink(movedDocs, docs, "dir");
            throw new Error("repository check failed after parent swap");
          },
        },
      ),
      "rollback-failed",
    );

    expect(await readFile(join(movedDocs, "guide.md"), "utf8")).toBe(REPAIRED);
    expect(await readFile(join(source, "docs/guide.md"), "utf8")).toBe(ORIGINAL);
    await expect(lstat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects expired approval and a forged active workspace", async () => {
    const capability = await authorizedCapability();
    await expectCode(
      applyBoundedLinkRepair({
        workspace,
        capability,
        evaluationTime: new Date("2026-08-04T16:00:00.000Z"),
      }),
      "authorization-expired",
    );

    const approval = approvalForPlan(plan());
    await expectCode(
      prepareBoundedLinkRepairCapability({
        workspace: {
          ...workspace,
          path: workspace.path,
        } as RepositoryWorkspace,
        approval,
        evaluationTime: NOW,
      }),
      "invalid-workspace",
    );
  });
});

async function authorizedCapability(): Promise<BoundedLinkRepairCapability> {
  return capabilityForPlan(plan());
}

function approvalForPlan(
  repairPlan: ApprovedBoundedLinkRepairPlan,
): BoundedLinkRepairApprovalGrant {
  return prepareBoundedLinkRepairApprovalGrant({
    plan: repairPlan,
    allowedApprovers: ALLOWED_APPROVERS,
    evaluationTime: NOW,
  });
}

async function capabilityForPlan(
  repairPlan: ApprovedBoundedLinkRepairPlan,
): Promise<BoundedLinkRepairCapability> {
  return prepareBoundedLinkRepairCapability({
    workspace,
    approval: approvalForPlan(repairPlan),
    evaluationTime: NOW,
  });
}

function plan(
  overrides: Partial<ApprovedBoundedLinkRepairPlan> = {},
): ApprovedBoundedLinkRepairPlan {
  const value = {
    schemaVersion: 1 as const,
    id: "repair:guide-link",
    repositoryRevision: workspace.revision,
    outputPath: "docs/guide.md",
    preimageSha256: sha(ORIGINAL),
    oldLink: "docs/old.md",
    newLink: "docs/new.md",
    approval: {
      status: "approved" as const,
      requirement: "maintainer" as const,
      approvedBy: "maintainer:example",
      approvedAt: "2026-08-03T15:00:00.000Z",
    },
    expiresAt: "2026-08-04T16:00:00.000Z",
    delivery: {
      mode: "patch-only" as const,
      mayMerge: false as const,
      mayPublish: false as const,
    },
    ...overrides,
  };
  return { ...value, digest: boundedLinkRepairPlanDigest(value) };
}

async function expectCode(
  action: Promise<unknown>,
  code: BoundedLinkRepairError["code"],
): Promise<void> {
  await expect(action).rejects.toMatchObject({ code });
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
