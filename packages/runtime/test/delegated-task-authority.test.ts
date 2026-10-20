// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DELEGATED_SCM_DENIED_MESSAGE,
  DELEGATED_SESSION_IS_NOT_AUTHORITY,
  DELEGATED_WRITE_ACTIVATION_MESSAGE,
  attemptDelegatedWriteActivation,
  createDelegatedTaskAuthority,
  currentInputIdentityForGrant,
  evidenceAttestsCurrentInput,
  executeAdmittedCheck,
  grantedCheckCapabilities,
  grantedDirectToolNames,
  inspectDelegatedGitMetadata,
  inspectDelegatedPath,
  probeDelegatedOperation,
  resolveDelegatedTaskAuthority,
  revokeDelegatedTaskAuthority,
  writeActivationSuppliersMissing,
  type DelegatedCheckDefinition,
  type DelegatedOperationClass,
} from "../src/delegated-task/authority-adapter.js";
import { temporaryRoots } from "./helpers/temp.js";
import { git, initFixtureRepo } from "./helpers/git.js";

const directories = temporaryRoots();
const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function authorityFixture(options: { readonly withCheck?: boolean } = {}): Promise<{
  repositoryPath: string;
  outputRoot: string;
  check?: DelegatedCheckDefinition;
}> {
  const root = await directories.create("docsfab-delegated-authority-");
  const repositoryPath = join(root, "fixture");
  const outputRoot = join(root, "check-output");
  await mkdir(outputRoot);
  await initFixtureRepo(
    repositoryPath,
    {
      "docs/guide.md": "Guide body.\n",
      "src/index.ts": "export {}\n",
      ".github/workflows/ci.yml": "name: ci\n",
      "docs-smoke.mjs": `import { readFile } from "node:fs/promises";
import { join } from "node:path";
const text = await readFile(join(process.cwd(), "docs/guide.md"), "utf8");
process.stdout.write(\`docs-smoke:\${text.trim()}\\n\`);
`,
      "package.json": `${JSON.stringify({ name: "fixture", private: true, scripts: { test: "node ./docs-smoke.mjs" } }, null, 2)}\n`,
    },
    { branch: "main" },
  );
  const check: DelegatedCheckDefinition | undefined = options.withCheck
    ? {
        checkId: "docs-smoke",
        manager: "npm",
        argv: ["test", "--", "docs-smoke"],
        cwd: repositoryPath,
        canonicalRepositoryPath: repositoryPath,
        environmentAllowlist: ["PATH", "LANG", "LC_ALL", "CI", "NO_COLOR", "TMPDIR"],
        sideEffectClass: "read-only",
        inputScope: ["docs/guide.md"],
        outputRoot,
        scriptName: "test",
      }
    : undefined;
  return { repositoryPath, outputRoot, check };
}

describe("delegated-task authority adapter", () => {
  it("lets a read-only grant inspect docs/guide.md while denied probes fail before side effects", async () => {
    const { repositoryPath } = await authorityFixture();
    const originalGuide = await readFile(join(repositoryPath, "docs", "guide.md"), "utf8");
    const originalSource = await readFile(join(repositoryPath, "src", "index.ts"), "utf8");
    const originalCi = await readFile(
      join(repositoryPath, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const logBefore = await git(repositoryPath, ["rev-parse", "HEAD"]);
    const authority = await createDelegatedTaskAuthority({ repositoryPath });
    const inspection = await inspectDelegatedPath(authority, "docs/guide.md");
    expect(inspection.status).toBe("allowed");
    if (inspection.status === "allowed") expect(inspection.value).toContain("Guide body.");
    expect(grantedDirectToolNames(authority)).toEqual(["read", "grep", "find", "ls"]);
    expect(grantedDirectToolNames(authority)).not.toEqual(
      expect.arrayContaining(["edit", "write", "bash"]),
    );

    const probes: DelegatedOperationClass[] = [
      "edit",
      "write",
      "generic-command",
      "git-scm",
      "source-code-write",
      "ci-write",
      "publication",
      "destructive",
    ];
    for (const operation of probes) {
      const path =
        operation === "source-code-write"
          ? "src/index.ts"
          : operation === "ci-write"
            ? ".github/workflows/ci.yml"
            : "docs/guide.md";
      const result = await probeDelegatedOperation(authority, operation, path);
      expect(result.status).toBe("denied");
    }

    expect(await readFile(join(repositoryPath, "docs", "guide.md"), "utf8")).toBe(originalGuide);
    expect(await readFile(join(repositoryPath, "src", "index.ts"), "utf8")).toBe(originalSource);
    expect(await readFile(join(repositoryPath, ".github", "workflows", "ci.yml"), "utf8")).toBe(
      originalCi,
    );
    expect(await git(repositoryPath, ["rev-parse", "HEAD"])).toBe(logBefore);
    expect(await git(repositoryPath, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repositoryPath, "destroyed"))).toBe(false);
  });

  it("fail-closes write activation when #779 is absent even after #758 branch preparation exists", async () => {
    const { repositoryPath } = await authorityFixture();
    const original = await readFile(join(repositoryPath, "docs", "guide.md"), "utf8");
    const authority = await createDelegatedTaskAuthority({ repositoryPath, allowWrite: true });
    const missing = writeActivationSuppliersMissing();
    expect(existsSync(resolve(RUNTIME_ROOT, "src/live-agent/branch-preparation.ts"))).toBe(true);
    expect(missing.blockedOn).toEqual(["#758", "#779"]);

    const failed = await attemptDelegatedWriteActivation(authority, {
      branchPreparation: { status: "failed" },
    });
    expect(failed.status).toBe("denied");
    if (failed.status === "denied") {
      expect(failed.branchReady).toBe(false);
      expect(failed.granted).toEqual({
        write: false,
        commit: false,
        push: false,
        mergeRequest: false,
        merge: false,
      });
    }
    const metadata = await inspectDelegatedGitMetadata(authority);
    expect(metadata.status).toBe("allowed");

    const succeededStub = await attemptDelegatedWriteActivation(authority, {
      branchPreparation: { status: "succeeded", branchName: "docs/task" },
    });
    expect(succeededStub.status).toBe("denied");
    if (succeededStub.status === "denied") {
      expect(succeededStub.message).toContain(DELEGATED_WRITE_ACTIVATION_MESSAGE);
      expect(succeededStub.message).toContain(DELEGATED_SCM_DENIED_MESSAGE);
      expect(succeededStub.granted?.commit).toBe(false);
      expect(succeededStub.granted?.push).toBe(false);
      expect(succeededStub.granted?.mergeRequest).toBe(false);
      expect(succeededStub.granted?.merge).toBe(false);
    }
    expect(await probeDelegatedOperation(authority, "commit")).toMatchObject({ status: "denied" });
    expect(await readFile(join(repositoryPath, "docs", "guide.md"), "utf8")).toBe(original);
    expect(await git(repositoryPath, ["status", "--porcelain"])).toBe("");
  });

  it("executes an admitted npm test -- docs-smoke check and rejects binding substitutions before spawn", async () => {
    const { repositoryPath, outputRoot, check } = await authorityFixture({ withCheck: true });
    const authority = await createDelegatedTaskAuthority({
      repositoryPath,
      admittedCheck: check,
    });
    expect(grantedCheckCapabilities(authority)).toEqual({
      adapter: "named-structured",
      temporaryOutput: true,
      edit: false,
      bash: false,
      scm: false,
      repositoryWrite: false,
    });

    const first = await executeAdmittedCheck(authority, check!);
    expect(first.status).toBe("allowed");
    if (first.status !== "allowed") throw new Error("expected first check to run");
    expect(first.value.output).toContain("docs-smoke:Guide body.");
    const firstIdentity = first.value.currentInputIdentitySha256;

    await writeFile(join(repositoryPath, "docs", "guide.md"), "Guide body revised.\n", "utf8");
    const second = await executeAdmittedCheck(authority, check!);
    expect(second.status).toBe("allowed");
    if (second.status !== "allowed") throw new Error("expected second check to run");
    expect(second.value.evidenceId).not.toBe(first.value.evidenceId);
    expect(second.value.currentInputIdentitySha256).not.toBe(firstIdentity);
    const current = await currentInputIdentityForGrant(authority);
    expect(evidenceAttestsCurrentInput(first.value, current)).toBe(false);
    expect(evidenceAttestsCurrentInput(second.value, current)).toBe(true);

    const mustNotSpawn = async () => {
      throw new Error("must-not-spawn");
    };
    const substitutions: Array<[string, DelegatedCheckDefinition]> = [
      ["argv order", { ...check!, argv: ["--", "test", "docs-smoke"] }],
      ["argv content", { ...check!, argv: ["test", "--", "other"] }],
      ["cwd", { ...check!, cwd: outputRoot }],
      ["canonical repository", { ...check!, canonicalRepositoryPath: outputRoot }],
      [
        "environment policy",
        { ...check!, environmentAllowlist: [...check!.environmentAllowlist, "GITLAB_TOKEN"] },
      ],
      ["unrelated input scope", { ...check!, inputScope: ["docs/guide.md", "src/index.ts"] }],
      ["output root", { ...check!, outputRoot: repositoryPath }],
      ["side-effect class", { ...check!, sideEffectClass: "write" }],
      ["executable identity", { ...check!, executableRealpath: "/bin/echo" }],
    ];
    for (const [, request] of substitutions) {
      const result = await executeAdmittedCheck(authority, request, { run: mustNotSpawn });
      expect(result.status).toBe("denied");
      if (result.status === "denied") expect(result.code).toBe("check-binding-mismatch");
    }

    await writeFile(
      join(repositoryPath, "package.json"),
      `${JSON.stringify({ name: "fixture", private: true, scripts: { test: "node ./other.mjs" } }, null, 2)}\n`,
      "utf8",
    );
    const scriptSwap = await executeAdmittedCheck(authority, check!, { run: mustNotSpawn });
    expect(scriptSwap.status).toBe("denied");
  });

  it("accepts a harmless repository alias and rejects a symlink retargeted after the grant", async () => {
    const { repositoryPath, outputRoot, check } = await authorityFixture({ withCheck: true });
    const root = dirname(repositoryPath);
    const alias = join(root, "alias");
    await symlink(repositoryPath, alias);
    const granted = {
      ...check!,
      cwd: alias,
      canonicalRepositoryPath: alias,
    };
    const authority = await createDelegatedTaskAuthority({
      repositoryPath: alias,
      admittedCheck: granted,
    });
    const viaAlias = await executeAdmittedCheck(authority, granted);
    expect(viaAlias.status).toBe("allowed");

    const other = join(root, "other-fixture");
    await mkdir(join(other, "docs"), { recursive: true });
    await writeFile(join(other, "docs", "guide.md"), "other\n", "utf8");
    await rm(alias);
    await symlink(other, alias);
    const retargeted = await executeAdmittedCheck(authority, granted, {
      run: async () => {
        throw new Error("must-not-spawn");
      },
    });
    expect(retargeted.status).toBe("denied");
    expect(outputRoot.length).toBeGreaterThan(0);
  });

  it("stops newly requested operations after revocation and refuses session lookalikes", async () => {
    const { repositoryPath } = await authorityFixture();
    const authority = await createDelegatedTaskAuthority({ repositoryPath });
    const first = await inspectDelegatedPath(authority, "docs/guide.md");
    expect(first.status).toBe("allowed");
    revokeDelegatedTaskAuthority(authority);
    const later = await inspectDelegatedPath(authority, "docs/guide.md");
    expect(later.status).toBe("denied");
    if (later.status === "denied") expect(later.code).toBe("grant-revoked");
    const lookalike = { kind: "docsfab-delegated-task-authority" as const };
    expect(resolveDelegatedTaskAuthority(lookalike)).toBeUndefined();
    const sessionHistory = {
      kind: "docsfab-delegated-task-authority" as const,
      messages: ["PRIOR_GRANT_TOKEN"],
    };
    expect(resolveDelegatedTaskAuthority(sessionHistory)).toBeUndefined();
    await expect(inspectDelegatedPath(lookalike, "docs/guide.md")).resolves.toMatchObject({
      status: "denied",
      code: "session-is-not-authority",
    });
    expect(DELEGATED_SESSION_IS_NOT_AUTHORITY.length).toBeGreaterThan(8);
  });

  it("stops newly requested operations after cancellation of the live grant signal", async () => {
    const { repositoryPath } = await authorityFixture();
    const controller = new AbortController();
    const authority = await createDelegatedTaskAuthority({
      repositoryPath,
      signal: controller.signal,
    });
    expect((await inspectDelegatedPath(authority, "docs/guide.md")).status).toBe("allowed");
    controller.abort();
    const cancelled = await inspectDelegatedPath(authority, "docs/guide.md");
    expect(cancelled.status).toBe("denied");
    if (cancelled.status === "denied") expect(cancelled.code).toBe("cancelled");
  });
});
