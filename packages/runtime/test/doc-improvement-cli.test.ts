// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { pinAcceptanceEvidenceDirectory } from "../src/acceptance-evidence.js";
import {
  DOC_IMPROVEMENT_GIT_CONFIG,
  parseDocImprovementCliOptions,
  assertPinnedValidationRuntimePaths,
  publishDocImprovementEvidence,
  pinValidationRuntimeAncestorChain,
  readPrivateDocImprovementPatch,
  runDocImprovementCli,
  assertDocImprovementCliBoundaries,
  assertDocImprovementSourceState,
  docImprovementIsolationCandidates,
  resolveValidationNpmRuntime,
  validationNpmRuntimeTreeDigest,
  verifyDocImprovementCampaign,
} from "../src/doc-improvement-cli.js";
import type { BoundedDocImprovementDeclarationV1 } from "../src/doc-improvement.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

const execFileAsync = promisify(execFile);

const roots: string[] = [];

async function fakeNpmRuntime(root: string, packageName: string): Promise<string> {
  const packageRoot = join(root, "npm-package");
  const cliPath = join(packageRoot, "bin", "npm-cli.js");
  await mkdir(dirname(cliPath), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
    }) + "\n",
  );
  await writeFile(cliPath, "process.exit(0);\n");
  await mkdir(join(packageRoot, "lib"));
  await writeFile(join(packageRoot, "lib", "nested.js"), "export const value = 1;\n");
  await symlink("nested.js", join(packageRoot, "lib", "nested-alias.js"));
  return cliPath;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeTreeWritable(root).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("bounded documentation improvement CLI", () => {
  it("turns off automatic gc and maintenance in the config every git command uses", () => {
    const pairs: string[] = [];
    for (let index = 0; index < DOC_IMPROVEMENT_GIT_CONFIG.length; index += 2) {
      expect(DOC_IMPROVEMENT_GIT_CONFIG[index]).toBe("-c");
      pairs.push(DOC_IMPROVEMENT_GIT_CONFIG[index + 1]!);
    }
    expect(pairs).toEqual(expect.arrayContaining(["gc.auto=0", "maintenance.auto=false"]));
  });

  it("parses required private inputs and keeps publication opt-in", () => {
    expect(
      parseDocImprovementCliOptions([
        "--repo",
        "repository",
        "--campaign-dir",
        "private-campaign",
        "--evidence-dir",
        "sanitized-evidence",
        "--reviewer-policy",
        "reviewers.json",
        "--npm-cache-capsule",
        "npm-cache",
      ]),
    ).toEqual({
      repository: resolve("repository"),
      campaignDirectory: resolve("private-campaign"),
      evidenceDirectory: resolve("sanitized-evidence"),
      reviewerPolicyPath: resolve("reviewers.json"),
      npmCacheCapsule: resolve("npm-cache"),
      allowWrite: false,
    });
    expect(
      parseDocImprovementCliOptions([
        "--repo",
        "repository",
        "--campaign-dir",
        "private-campaign",
        "--evidence-dir",
        "sanitized-evidence",
        "--reviewer-policy",
        "reviewers.json",
        "--npm-cache-capsule",
        "npm-cache",
        "--allow-write",
      ]).allowWrite,
    ).toBe(true);
  });

  it.each([
    [],
    ["--repo", "repository"],
    ["--repo", "repository", "--campaign-dir", "campaign", "--evidence-dir"],
    ["--repo", "repository", "--campaign-dir", "campaign", "--evidence-dir", "out", "--live"],
    ["--repo", "one", "--repo", "two", "--campaign-dir", "campaign", "--evidence-dir", "out"],
    [
      "--repo",
      "one",
      "--campaign-dir",
      "campaign",
      "--evidence-dir",
      "out",
      "--allow-write",
      "--allow-write",
    ],
  ] as string[][])(
    "rejects incomplete, unknown, and duplicate option sets",
    (...args: string[]) => {
      expect(() => parseDocImprovementCliOptions(args)).toThrow();
    },
  );

  it("reads one stable owner-only patch from the pinned campaign directory", async () => {
    const root = await privateRoot();
    await writeFile(join(root, "improvement.patch"), "bounded patch\n", { mode: 0o600 });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    await expect(readPrivateDocImprovementPatch(pinned, "improvement.patch")).resolves.toEqual(
      Buffer.from("bounded patch\n"),
    );
  });

  it("rejects permissive, symlinked, and hard-linked patch leaves", async () => {
    const permissiveRoot = await privateRoot();
    const permissive = join(permissiveRoot, "permissive.patch");
    await writeFile(permissive, "patch\n", { mode: 0o600 });
    await chmod(permissive, 0o644);
    await expect(
      readPrivateDocImprovementPatch(
        await pinAcceptanceEvidenceDirectory(permissiveRoot),
        "permissive.patch",
      ),
    ).rejects.toThrow("could not be read safely");

    const symlinkRoot = await privateRoot();
    const target = join(symlinkRoot, "target.patch");
    await writeFile(target, "patch\n", { mode: 0o600 });
    await symlink(target, join(symlinkRoot, "linked.patch"));
    await expect(
      readPrivateDocImprovementPatch(
        await pinAcceptanceEvidenceDirectory(symlinkRoot),
        "linked.patch",
      ),
    ).rejects.toThrow("could not be read safely");

    const hardLinkRoot = await privateRoot();
    const original = join(hardLinkRoot, "original.patch");
    await writeFile(original, "patch\n", { mode: 0o600 });
    await link(original, join(hardLinkRoot, "hard-linked.patch"));
    await expect(
      readPrivateDocImprovementPatch(
        await pinAcceptanceEvidenceDirectory(hardLinkRoot),
        "hard-linked.patch",
      ),
    ).rejects.toThrow("could not be read safely");
  });

  it("rejects post-read patch permission and link-count changes", async () => {
    const permissionRoot = await privateRoot();
    const permissionPatch = join(permissionRoot, "permission.patch");
    await writeFile(permissionPatch, "patch\n", { mode: 0o600 });
    await expect(
      readPrivateDocImprovementPatch(
        await pinAcceptanceEvidenceDirectory(permissionRoot),
        "permission.patch",
        { afterRead: async () => chmod(permissionPatch, 0o400) },
      ),
    ).rejects.toThrow("could not be read safely");

    const linkRoot = await privateRoot();
    const linkedPatch = join(linkRoot, "linked.patch");
    await writeFile(linkedPatch, "patch\n", { mode: 0o600 });
    await expect(
      readPrivateDocImprovementPatch(
        await pinAcceptanceEvidenceDirectory(linkRoot),
        "linked.patch",
        { afterRead: async () => link(linkedPatch, join(linkRoot, "late-link.patch")) },
      ),
    ).rejects.toThrow("could not be read safely");
  });

  it("detects output ancestor swaps and invalidates the already-written success bytes", async () => {
    const root = await privateRoot();
    const outsideParent = join(root, "outside");
    const evidenceDirectory = join(outsideParent, "evidence");
    const displacedParent = join(root, "outside-displaced");
    const source = join(root, "source");
    const ignored = join(source, ".docsfab");
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await chmod(outsideParent, 0o700);
    await chmod(evidenceDirectory, 0o700);
    await mkdir(ignored, { recursive: true, mode: 0o700 });
    const pinned = await pinAcceptanceEvidenceDirectory(evidenceDirectory);
    const publication = await publishDocImprovementEvidence(pinned, {
      decision: "passed",
    } as never);
    await rename(outsideParent, displacedParent);
    await symlink(ignored, outsideParent);

    await expect(publication.assertStable()).rejects.toThrow();
    await publication.invalidate();
    expect(
      (await readFile(join(displacedParent, "evidence", "bounded-doc-improvement.json")))
        .byteLength,
    ).toBe(0);
    await expect(
      readFile(join(ignored, "evidence", "bounded-doc-improvement.json")),
    ).rejects.toThrow();
  });

  it("detects a terminal same-inode output alias and invalidates the held descriptor", async () => {
    const root = await privateRoot();
    const outputParent = join(root, "output");
    const evidenceDirectory = join(outputParent, "evidence");
    const movedParent = join(root, "moved");
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await chmod(outputParent, 0o700);
    await chmod(evidenceDirectory, 0o700);
    const pinned = await pinAcceptanceEvidenceDirectory(evidenceDirectory);
    const publication = await publishDocImprovementEvidence(pinned, {
      decision: "passed",
    } as never);
    await rename(outputParent, movedParent);
    await symlink(movedParent, outputParent);

    await expect(publication.assertStable()).rejects.toThrow();
    await publication.invalidate();
    expect(
      (await readFile(join(movedParent, "evidence", "bounded-doc-improvement.json"))).byteLength,
    ).toBe(0);
  });

  it("rejects actual out-of-scope patch paths before dependency installation", async () => {
    const repository = await privateRoot();
    await writeFile(join(repository, "README.md"), "# Fixture\n");
    const packageBytes = Buffer.from('{"name":"fixture","version":"1.0.0"}\n');
    await writeFile(join(repository, "package.json"), packageBytes);
    await initFixtureRepo(repository);
    const revision = await commitFixture(repository);
    await writeFile(
      join(repository, "package.json"),
      '{"name":"fixture","version":"1.0.0","scripts":{"check":"echo unsafe"}}\n',
    );
    const patch = Buffer.from(
      await git(repository, ["diff", "--binary", "--full-index"], { trim: false }),
    );
    await writeFile(join(repository, "package.json"), packageBytes);
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
    const canonical = await import("node:fs/promises").then(({ realpath }) => realpath(repository));
    const declaration = {
      schemaVersion: 1,
      kind: "bounded-doc-improvement-campaign",
      campaignId: "scope-test",
      repositoryId: "fixture/repository",
      testedCommit: revision,
      repositoryIdentitySha256: sha256(Buffer.from(canonical)),
      gap: {
        id: "fixture-gap",
        evidence: [{ path: "README.md", sha256: sha256(Buffer.from("# Fixture\n")) }],
        successCriterion: "Clarify the fixture documentation.",
      },
      inputs: {
        analysisRecord: { file: "analysis.json", sha256: "a".repeat(64) },
        authorization: { file: "authorization.json", sha256: "b".repeat(64) },
        applicationRecord: { file: "application.json", sha256: "c".repeat(64) },
        patch: { file: "change.patch", sha256: sha256(patch), byteLength: patch.byteLength },
        independentReview: { file: "review.json", sha256: "d".repeat(64) },
      },
      validationProfile: "docsfab",
      generatedAt: "2026-08-04T12:00:00.000Z",
      digest: "e".repeat(64),
    } satisfies BoundedDocImprovementDeclarationV1;
    const npmCache = await createNpmCacheCapsule(declaration.campaignId);

    await expect(
      verifyDocImprovementCampaign(repository, declaration, patch, ["README.md"], npmCache),
    ).rejects.toThrow("exceeds its approved paths");
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
  });

  it("rejects campaign, policy, and evidence roots inside the selected source", async () => {
    const repository = await privateRoot();
    const canonicalRepository = await realpath(repository);
    const campaign = await privateRoot();
    const policyRoot = await privateRoot();
    const policyPath = join(policyRoot, "reviewers.json");
    await writeFile(policyPath, "{}\n", { mode: 0o600 });
    await expect(
      assertDocImprovementCliBoundaries({
        repository: canonicalRepository,
        campaignDirectory: campaign,
        evidenceDirectory: join(canonicalRepository, ".docsfab", "evidence"),
        reviewerPolicyPath: policyPath,
        npmCacheCapsule: campaign,
        allowWrite: true,
      }),
    ).rejects.toThrow("--evidence-dir must be outside");
  });

  it("rechecks the source checkout after publication", async () => {
    const repository = await privateRoot();
    await writeFile(join(repository, "README.md"), "# Fixture\n");
    await initFixtureRepo(repository);
    const revision = await commitFixture(repository);
    await assertDocImprovementSourceState(repository, revision);
    await writeFile(join(repository, "published-evidence.json"), "{}\n");
    await expect(assertDocImprovementSourceState(repository, revision)).rejects.toThrow(
      "changed after publication",
    );
  });

  it("binds the complete trusted campaign before invoking verification", async () => {
    const repository = await realpath(await privateRoot());
    const campaign = await realpath(await privateRoot());
    const policyRoot = await realpath(await privateRoot());
    const policyPath = join(policyRoot, "reviewers.json");
    await writeFile(policyPath, "{}\n", { mode: 0o600 });
    let verificationCalled = false;
    await expect(
      runDocImprovementCli(
        {
          repository,
          campaignDirectory: campaign,
          evidenceDirectory: join(policyRoot, "evidence"),
          reviewerPolicyPath: policyPath,
          npmCacheCapsule: campaign,
          allowWrite: false,
        },
        {
          loadCampaign: async () => ({}) as never,
          loadReviewerPolicy: async () => ({}) as never,
          verify: async () => {
            verificationCalled = true;
            throw new Error("must not execute");
          },
        },
      ),
    ).rejects.toThrow();
    expect(verificationCalled).toBe(false);
  });

  it("rejects deletion even when the deleted documentation path is intended", async () => {
    const repository = await privateRoot();
    const readme = Buffer.from("# Fixture\n");
    await writeFile(join(repository, "README.md"), readme);
    await writeFile(join(repository, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await initFixtureRepo(repository);
    const revision = await commitFixture(repository);
    await unlink(join(repository, "README.md"));
    const patch = Buffer.from(
      await git(repository, ["diff", "--binary", "--full-index"], { trim: false }),
    );
    await writeFile(join(repository, "README.md"), readme);
    const canonical = await import("node:fs/promises").then(({ realpath }) => realpath(repository));
    const declaration = {
      schemaVersion: 1,
      kind: "bounded-doc-improvement-campaign",
      campaignId: "delete-test",
      repositoryId: "fixture/repository",
      testedCommit: revision,
      repositoryIdentitySha256: sha256(Buffer.from(canonical)),
      gap: {
        id: "gap",
        evidence: [{ path: "README.md", sha256: sha256(readme) }],
        successCriterion: "Clarify docs.",
      },
      inputs: {
        analysisRecord: { file: "analysis.json", sha256: "a".repeat(64) },
        authorization: { file: "authorization.json", sha256: "b".repeat(64) },
        applicationRecord: { file: "application.json", sha256: "c".repeat(64) },
        patch: { file: "change.patch", sha256: sha256(patch), byteLength: patch.byteLength },
        independentReview: { file: "review.json", sha256: "d".repeat(64) },
      },
      validationProfile: "docsfab",
      generatedAt: "2026-08-04T12:00:00.000Z",
      digest: "e".repeat(64),
    } satisfies BoundedDocImprovementDeclarationV1;
    const npmCache = await createNpmCacheCapsule(declaration.campaignId);
    await expect(
      verifyDocImprovementCampaign(repository, declaration, patch, ["README.md"], npmCache),
    ).rejects.toThrow("unsupported file change");
  });

  it("rejects executable repository Git configuration before hooks can receive ambient credentials", async () => {
    const fixture = await verificationFixture();
    const hooks = join(fixture.repository, ".hooks");
    const marker = join(fixture.repository, "hook-credential-marker");
    await mkdir(hooks);
    const hook = join(hooks, "fsmonitor");
    await writeFile(hook, `#!/bin/sh\nprintf '%s' "$SCM_TOKEN" > ${JSON.stringify(marker)}\n`);
    await chmod(hook, 0o700);
    await git(fixture.repository, ["config", "core.fsmonitor", hook]);
    const previous = process.env.SCM_TOKEN;
    process.env.SCM_TOKEN = "ambient-secret-must-not-reach-hook";
    try {
      await expect(
        verifyDocImprovementCampaign(
          fixture.repository,
          fixture.declaration,
          fixture.patch,
          ["README.md"],
          fixture.npmCache,
        ),
      ).rejects.toThrow("executable or included Git configuration");
      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.SCM_TOKEN;
      else process.env.SCM_TOKEN = previous;
    }
  });

  it("holds exact patch bytes at entry and never follows a substituted patch value", async () => {
    const fixture = await verificationFixture();
    const mutablePatch = Buffer.from(fixture.patch);
    await expect(
      verifyDocImprovementCampaign(
        fixture.repository,
        fixture.declaration,
        mutablePatch,
        ["README.md"],
        fixture.npmCache,
        {
          afterPatchHeld: () => {
            mutablePatch.fill(0x78);
          },
          afterApply: async (workspace) => {
            expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
              "# Fixture\n\nBounded clarification.\n",
            );
            throw new Error("held patch confirmed");
          },
        },
      ),
    ).rejects.toThrow("held patch confirmed");
  });

  it("rejects any mutation of the applied tree before validation", async () => {
    const fixture = await verificationFixture();
    await expect(
      verifyDocImprovementCampaign(
        fixture.repository,
        fixture.declaration,
        fixture.patch,
        ["README.md"],
        fixture.npmCache,
        {
          afterApply: async (workspace) => {
            await writeFile(join(workspace, "README.md"), "validation substituted content\n");
          },
        },
      ),
    ).rejects.toThrow("applied tree changed before validation");
  });

  it("offers only the Linux PID-namespace validation profile", () => {
    const request = {
      workspacePath: "/tmp/docsfab-workspace/repository",
      scratchPath: "/tmp/docsfab-validation",
      deniedReadPaths: ["/home/operator/source/README.md", "/tmp/host-git/config"],
      deniedWritePaths: ["/home/operator/source/forbidden"],
      readOnlyDirectories: ["/cache"],
      readOnlyFiles: ["/tmp/docsfab-validation/user.conf", "/tmp/docsfab-validation/global.conf"],
      runtimeReadDirectories: ["/opt/node-v24", "/opt/npm-runtime"],
    };
    expect(docImprovementIsolationCandidates(request, "darwin")).toEqual([]);
    const [linux] = docImprovementIsolationCandidates(request, "linux", "/opt/node-v24/bin/node");
    expect(linux).toBeDefined();
    if (!linux) throw new Error("expected Linux isolation arguments");
    expect(linux).toEqual(
      expect.arrayContaining([
        "/usr/bin/bwrap",
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--new-session",
        "--tmpfs",
        "/",
      ]),
    );
    expect(linux.join("\0")).not.toContain("--ro-bind\0/\0/");
    expect(linux.join("\0")).not.toContain("/tmp/host-git");
    expect(linux.join("\0")).toContain("--ro-bind\0/cache\0/cache");
    expect(linux.join("\0")).toContain(
      "--ro-bind\0/tmp/docsfab-validation/user.conf\0/tmp/docsfab-validation/user.conf",
    );
    const argumentIndex = (values: string[]): number =>
      linux.findIndex((_, index) =>
        values.every((value, offset) => linux[index + offset] === value),
      );
    const runtimeMountTargets = [
      "/usr",
      "/usr/local",
      "/bin",
      "/lib",
      "/lib64",
      "/etc",
      "/etc/ssl",
      "/opt",
      "/opt/node-v24",
      "/opt/node-v24/bin",
      "/opt/npm-runtime",
    ];
    for (const directory of runtimeMountTargets) {
      expect(argumentIndex(["--dir", directory])).toBeGreaterThan(-1);
    }
    expect(argumentIndex(["--dir", "/usr"])).toBeLessThan(
      argumentIndex(["--ro-bind-try", "/usr", "/usr"]),
    );
    expect(argumentIndex(["--dir", "/opt/node-v24/bin"])).toBeLessThan(
      argumentIndex(["--ro-bind", "/opt/node-v24/bin/node", "/opt/node-v24/bin/node"]),
    );
    expect(argumentIndex(["--dir", "/opt/npm-runtime"])).toBeLessThan(
      argumentIndex(["--ro-bind", "/opt/npm-runtime", "/opt/npm-runtime"]),
    );
    expect(argumentIndex(["--dir", "/etc"])).toBeLessThan(
      argumentIndex(["--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache"]),
    );
    expect(argumentIndex(["--dir", "/cache"])).toBeLessThan(
      argumentIndex(["--ro-bind", "/cache", "/cache"]),
    );
  });

  it("rejects npm_execpath and PATH shims that do not belong to the npm package", async () => {
    const hostileRoot = await privateRoot();
    const cliPath = await fakeNpmRuntime(hostileRoot, "not-npm");
    const previousExecPath = process.env.npm_execpath;
    const previousPath = process.env.PATH;
    try {
      process.env.npm_execpath = cliPath;
      await expect(resolveValidationNpmRuntime()).rejects.toThrow("npm runtime is unavailable");
      delete process.env.npm_execpath;
      process.env.PATH = dirname(cliPath);
      await writeFile(join(dirname(cliPath), "npm"), "#!/bin/sh\nexit 0\n");
      await chmod(join(dirname(cliPath), "npm"), 0o755);
      await expect(resolveValidationNpmRuntime()).rejects.toThrow("npm runtime is unavailable");
    } finally {
      if (previousExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = previousExecPath;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("rejects a same-user npm runtime in production validation", async () => {
    const runtimeRoot = await privateRoot();
    const cliPath = await fakeNpmRuntime(runtimeRoot, "npm");
    const previousExecPath = process.env.npm_execpath;
    try {
      process.env.npm_execpath = cliPath;
      await expect(resolveValidationNpmRuntime()).rejects.toThrow(
        typeof process.getuid === "function" && process.getuid() === 0
          ? "requires an unprivileged process"
          : "unsafe ownership or mode",
      );
    } finally {
      if (previousExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = previousExecPath;
    }
  });

  it("detects an in-place edit of the pinned npm CLI", async () => {
    const runtimeRoot = await privateRoot();
    const cliPath = await fakeNpmRuntime(runtimeRoot, "npm");
    const previousExecPath = process.env.npm_execpath;
    try {
      process.env.npm_execpath = cliPath;
      const packageRoot = join(runtimeRoot, "npm-package");
      const owner = (await lstat(packageRoot)).uid;
      const before = await validationNpmRuntimeTreeDigest(packageRoot, owner, false);
      await writeFile(cliPath, "replacement npm runtime\n");
      expect(await validationNpmRuntimeTreeDigest(packageRoot, owner, false)).not.toBe(before);
    } finally {
      if (previousExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = previousExecPath;
    }
  });

  it("detects an in-place edit of a nested npm package module", async () => {
    const runtimeRoot = await privateRoot();
    const cliPath = await fakeNpmRuntime(runtimeRoot, "npm");
    const previousExecPath = process.env.npm_execpath;
    try {
      process.env.npm_execpath = cliPath;
      const packageRoot = join(runtimeRoot, "npm-package");
      const owner = (await lstat(packageRoot)).uid;
      const before = await validationNpmRuntimeTreeDigest(packageRoot, owner, false);
      await writeFile(
        join(runtimeRoot, "npm-package", "lib", "nested.js"),
        "export const value = 'hostile';\n",
      );
      expect(await validationNpmRuntimeTreeDigest(packageRoot, owner, false)).not.toBe(before);
    } finally {
      if (previousExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = previousExecPath;
    }
  });

  it("rejects a metadata-safe runtime entry when the effective write check fails", async () => {
    const runtimeRoot = await privateRoot();
    await fakeNpmRuntime(runtimeRoot, "npm");
    const packageRoot = join(runtimeRoot, "npm-package");
    await chmod(join(packageRoot, "package.json"), 0o444);
    await chmod(join(packageRoot, "bin", "npm-cli.js"), 0o444);
    await chmod(join(packageRoot, "lib", "nested.js"), 0o444);
    await chmod(join(packageRoot, "bin"), 0o555);
    await chmod(join(packageRoot, "lib"), 0o555);
    await chmod(packageRoot, 0o555);
    const owner = (await lstat(packageRoot)).uid;

    await expect(
      validationNpmRuntimeTreeDigest(packageRoot, owner, true, async () => {
        throw new Error("effective ACL grants write access");
      }),
    ).rejects.toThrow("effective ACL grants write access");
  });

  it("detects a writable intermediate runtime ancestor swapped in place", async () => {
    const runtimeRoot = await privateRoot();
    const cliPath = await realpath(await fakeNpmRuntime(runtimeRoot, "npm"));
    const packageRoot = dirname(dirname(cliPath));
    const mutableAncestor = join(packageRoot, "lib");
    const movedAncestor = join(packageRoot, "lib-before-swap");
    const identities = await pinValidationRuntimeAncestorChain(
      [cliPath, mutableAncestor],
      null,
      false,
      false,
    );

    await rename(mutableAncestor, movedAncestor);
    await mkdir(mutableAncestor);

    await expect(assertPinnedValidationRuntimePaths(identities, false)).rejects.toThrow(
      "npm runtime changed during validation",
    );
  });

  it("ignores Git replacement objects while binding source and gap evidence", async () => {
    const fixture = await verificationFixture();
    const original = fixture.declaration.testedCommit;
    await writeFile(join(fixture.repository, "README.md"), "replacement-object content\n");
    await git(fixture.repository, ["add", "README.md"]);
    const replacementTree = await git(fixture.repository, ["write-tree"]);
    const replacement = await git(fixture.repository, [
      "commit-tree",
      replacementTree,
      "-p",
      original,
      "-m",
      "replacement",
    ]);
    await git(fixture.repository, ["reset", "--hard", original], {
      env: { GIT_NO_REPLACE_OBJECTS: "1" },
    });
    await git(fixture.repository, ["replace", original, replacement]);
    await expect(
      verifyDocImprovementCampaign(
        fixture.repository,
        fixture.declaration,
        fixture.patch,
        ["README.md"],
        fixture.npmCache,
        {
          afterApply: () => {
            throw new Error("replace objects disabled");
          },
        },
      ),
    ).rejects.toThrow("replace objects disabled");
  });

  it.runIf(process.platform === "linux")(
    "runs a real cached dependency lock while hostile Git filters cannot escape validation",
    async () => {
      const markerRoot = await privateRoot();
      const marker = join(markerRoot, "host-filter-marker");
      const fixture = await dependencyVerificationFixture(marker);
      const evidence = await verifyDocImprovementCampaign(
        fixture.repository,
        fixture.declaration,
        fixture.patch,
        ["README.md"],
        fixture.npmCache,
      );
      expect(evidence.patchApply.exitCode).toBe(0);
      expect(evidence.dependencyInstall.exitCode).toBe(0);
      expect(evidence.validation.map((entry) => entry.exitCode)).toEqual([0, 0]);
      expect(await git(fixture.repository, ["status", "--porcelain"])).toBe("");
      expect(await readFile(join(fixture.repository, "package-lock.json"), "utf8")).toContain(
        "cached-dependency",
      );
      await expect(readFile(marker)).rejects.toThrow();
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a validation command that mutates the authorized tracked tree",
    async () => {
      const fixture = await dependencyVerificationFixture();
      await expect(
        verifyDocImprovementCampaign(
          fixture.repository,
          fixture.declaration,
          fixture.patch,
          ["README.md"],
          fixture.npmCache,
          {
            afterValidation: async (workspace) => {
              await writeFile(join(workspace, "README.md"), "validation mutation\n");
            },
          },
        ),
      ).rejects.toThrow("validation changed the authorized applied tree");
    },
  );

  it.runIf(process.platform === "linux")(
    "fails closed when the campaign cache capsule misses a locked dependency",
    async () => {
      const fixture = await dependencyVerificationFixture();
      const emptyCache = await createNpmCacheCapsule(fixture.declaration.campaignId);
      await expect(
        verifyDocImprovementCampaign(
          fixture.repository,
          fixture.declaration,
          fixture.patch,
          ["README.md"],
          emptyCache,
        ),
      ).rejects.toThrow("repository validation failed closed");
      expect(await git(fixture.repository, ["status", "--porcelain"])).toBe("");
    },
  );
});

async function verificationFixture(): Promise<{
  repository: string;
  declaration: BoundedDocImprovementDeclarationV1;
  patch: Buffer;
  npmCache: string;
}> {
  const repository = await privateRoot();
  const readme = Buffer.from("# Fixture\n");
  await writeFile(join(repository, "README.md"), readme);
  await writeFile(join(repository, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      name: "doc-improvement-fixture",
      version: "1.0.0",
      scripts: {
        check:
          "node -e \"const f=require('node:fs').readFileSync('README.md','utf8');if(!f.includes('Bounded clarification.'))process.exit(1)\"",
        build:
          "node -e \"const f=require('node:fs').readFileSync('README.md','utf8');if(!f.includes('Bounded clarification.'))process.exit(1)\"",
      },
    }) + "\n",
  );
  await writeFile(
    join(repository, "package-lock.json"),
    JSON.stringify({
      name: "doc-improvement-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "doc-improvement-fixture", version: "1.0.0" } },
    }) + "\n",
  );
  await initFixtureRepo(repository);
  const revision = await commitFixture(repository);
  await writeFile(join(repository, "README.md"), "# Fixture\n\nBounded clarification.\n");
  const patch = Buffer.from(
    await git(repository, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv"], {
      trim: false,
    }),
  );
  await writeFile(join(repository, "README.md"), readme);
  const canonical = await realpath(repository);
  const declaration = {
    schemaVersion: 1,
    kind: "bounded-doc-improvement-campaign",
    campaignId: "security-verification",
    repositoryId: "fixture/repository",
    testedCommit: revision,
    repositoryIdentitySha256: sha256(Buffer.from(canonical)),
    gap: {
      id: "fixture-gap",
      evidence: [{ path: "README.md", sha256: sha256(readme) }],
      successCriterion: "Add the bounded clarification.",
    },
    inputs: {
      analysisRecord: { file: "analysis.json", sha256: "a".repeat(64) },
      authorization: { file: "authorization.json", sha256: "b".repeat(64) },
      applicationRecord: { file: "application.json", sha256: "c".repeat(64) },
      patch: { file: "change.patch", sha256: sha256(patch), byteLength: patch.byteLength },
      independentReview: { file: "review.json", sha256: "d".repeat(64) },
    },
    validationProfile: "docsfab",
    generatedAt: "2026-08-04T12:00:00.000Z",
    digest: "e".repeat(64),
  } satisfies BoundedDocImprovementDeclarationV1;
  const npmCache = await createNpmCacheCapsule(declaration.campaignId);
  return { repository, declaration, patch, npmCache };
}

async function dependencyVerificationFixture(hostMarker?: string): Promise<{
  repository: string;
  declaration: BoundedDocImprovementDeclarationV1;
  patch: Buffer;
  npmCache: string;
}> {
  const dependency = await privateRoot();
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "cached-dependency",
      version: "1.0.0",
      main: "index.js",
    }) + "\n",
  );
  await writeFile(join(dependency, "index.js"), "module.exports = 'cached';\n");
  const served = await privateRoot();
  const packed = await execFileAsync("npm", ["pack", "--json", "--pack-destination", served], {
    cwd: dependency,
    encoding: "utf8",
  });
  const packResult = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const tarball = await readFile(join(served, packResult[0]!.filename));
  const server = createServer((request, response) => {
    if (request.url !== "/cached-dependency-1.0.0.tgz") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-length", String(tarball.byteLength));
    response.end(tarball);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture server address");
  const dependencyUrl = `http://127.0.0.1:${address.port}/cached-dependency-1.0.0.tgz`;

  const repository = await privateRoot();
  const readme = Buffer.from("# Fixture\n");
  await writeFile(join(repository, "README.md"), readme);
  await writeFile(join(repository, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(join(repository, ".gitattributes"), "README.md filter=attack\n");
  const checkScript = [
    "const fs=require('node:fs'),path=require('node:path');",
    "const value=fs.readFileSync('README.md','utf8');",
    "if(!value.includes('Bounded clarification.'))process.exit(1);",
    ...(hostMarker
      ? [
          "const attack=path.join(process.env.HOME,'host-filter-attack.sh');",
          `fs.writeFileSync(attack,${JSON.stringify(`#!/bin/sh\ntouch ${JSON.stringify(hostMarker)}\nexit 1\n`)},{mode:0o700});`,
          "fs.writeFileSync(path.join(process.env.HOME,'.gitconfig'),`[filter \"attack\"]\n\tclean = /bin/sh ${attack}\n\tprocess = /bin/sh ${attack}\n\trequired = true\n`);",
        ]
      : []),
  ].join("\n");
  await writeFile(join(repository, "validation-check.cjs"), `${checkScript}\n`);
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      name: "doc-improvement-dependency-fixture",
      version: "1.0.0",
      scripts: {
        check: "node validation-check.cjs",
        build: "node -e \"if(require('cached-dependency')!=='cached')process.exit(1)\"",
      },
      dependencies: { "cached-dependency": dependencyUrl },
    }) + "\n",
  );

  const cacheParent = await privateRoot();
  const cacheWorking = join(cacheParent, "cache-working");
  await mkdir(cacheWorking, { mode: 0o700 });
  const setupUserConfig = join(cacheParent, "setup-user.conf");
  const setupGlobalConfig = join(cacheParent, "setup-global.conf");
  await writeFile(setupUserConfig, "", { mode: 0o600 });
  await writeFile(setupGlobalConfig, "", { mode: 0o600 });
  try {
    await execFileAsync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
      cwd: repository,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: cacheParent,
        npm_config_cache: cacheWorking,
        npm_config_userconfig: setupUserConfig,
        npm_config_globalconfig: setupGlobalConfig,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
  await rm(join(cacheWorking, "_logs"), { recursive: true, force: true });
  await rm(join(cacheWorking, "_update-notifier-last-checked"), { force: true });
  const npmCache = await finalizeNpmCacheCapsule(
    cacheParent,
    cacheWorking,
    "security-verification-dependency",
  );

  await initFixtureRepo(repository);
  const revision = await commitFixture(repository);
  await writeFile(join(repository, "README.md"), "# Fixture\n\nBounded clarification.\n");
  const patch = Buffer.from(
    await git(repository, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv"], {
      trim: false,
    }),
  );
  await writeFile(join(repository, "README.md"), readme);
  const canonical = await realpath(repository);
  const declaration = {
    schemaVersion: 1,
    kind: "bounded-doc-improvement-campaign",
    campaignId: "security-verification-dependency",
    repositoryId: "fixture/repository",
    testedCommit: revision,
    repositoryIdentitySha256: sha256(Buffer.from(canonical)),
    gap: {
      id: "fixture-gap",
      evidence: [{ path: "README.md", sha256: sha256(readme) }],
      successCriterion: "Add the bounded clarification.",
    },
    inputs: {
      analysisRecord: { file: "analysis.json", sha256: "a".repeat(64) },
      authorization: { file: "authorization.json", sha256: "b".repeat(64) },
      applicationRecord: { file: "application.json", sha256: "c".repeat(64) },
      patch: { file: "change.patch", sha256: sha256(patch), byteLength: patch.byteLength },
      independentReview: { file: "review.json", sha256: "d".repeat(64) },
    },
    validationProfile: "docsfab",
    generatedAt: "2026-08-04T12:00:00.000Z",
    digest: "e".repeat(64),
  } satisfies BoundedDocImprovementDeclarationV1;
  return { repository, declaration, patch, npmCache };
}

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-doc-improvement-cli-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function createNpmCacheCapsule(campaignId: string): Promise<string> {
  const parent = await privateRoot();
  const working = join(parent, "cache-working");
  await mkdir(working, { mode: 0o700 });
  return finalizeNpmCacheCapsule(parent, working, campaignId);
}

async function finalizeNpmCacheCapsule(
  parent: string,
  working: string,
  campaignId: string,
): Promise<string> {
  await makeCacheContentImmutable(working);
  const contentSha256 = await testNpmCacheContentDigest(working);
  const capsule = join(parent, `sha256-${contentSha256}`);
  await rename(working, capsule);
  await writeFile(
    join(capsule, "docsfab-npm-cache.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "doc-improvement-npm-cache",
      campaignId,
      contentSha256,
    }) + "\n",
    { mode: 0o400, flag: "wx" },
  );
  await chmod(capsule, 0o500);
  return capsule;
}

async function makeCacheContentImmutable(directory: string): Promise<void> {
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(directory, { withFileTypes: true }),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeCacheContentImmutable(path);
      await chmod(path, 0o500);
    } else {
      await chmod(path, 0o400);
    }
  }
}

async function testNpmCacheContentDigest(root: string): Promise<string> {
  const entries: Array<{
    path: string;
    kind: "directory" | "file";
    byteLength?: number;
    sha256?: string;
  }> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await import("node:fs/promises").then(({ readdir }) =>
      readdir(directory, { withFileTypes: true }),
    );
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory" });
        await visit(path, relativePath);
      } else {
        const value = await readFile(path);
        entries.push({
          path: relativePath,
          kind: "file",
          byteLength: value.byteLength,
          sha256: sha256(value),
        });
      }
    }
  };
  await visit(root, "");
  return sha256(Buffer.from(JSON.stringify(entries)));
}

async function makeTreeWritable(path: string): Promise<void> {
  const info = await import("node:fs/promises").then(({ lstat }) => lstat(path));
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(path, { withFileTypes: true }),
  );
  for (const entry of entries) await makeTreeWritable(join(path, entry.name));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
