// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import { DOCSFAB_PROJECT_CONFIG_FILE } from "../src/init/types.js";
import {
  PRIVATE_GITIGNORE_ENTRIES,
  applyPrivateGitignorePlan,
  appendPrivateGitignoreFragment,
  assertPrivateOnlyGitignoreEntries,
  gitignoreLineIgnoresProjectConfig,
  inspectPrivateGitignorePlan,
  missingPrivateGitignoreEntries,
} from "../src/init/gitignore.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporaryDirectories = temporaryRoots();

describe("init private gitignore fragment", () => {
  it("previews a missing file without creating it, then applies only the approved entries", async () => {
    const repository = await temporaryDirectories.create("docsfab-init-gitignore-");
    const plan = await inspectPrivateGitignorePlan(repository);
    expect(plan).toMatchObject({
      path: ".gitignore",
      action: "create",
      missingEntries: [".docsfab/", ".docsfab-init.*"],
    });
    expect(plan.preimageSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(readFile(join(repository, ".gitignore"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await applyPrivateGitignorePlan(repository, plan)).toEqual({
      status: "created",
      added: [".docsfab/", ".docsfab-init.*"],
    });
    const after = await readFile(join(repository, ".gitignore"), "utf8");
    const complete = await inspectPrivateGitignorePlan(repository);
    expect(complete).toMatchObject({ action: "none", missingEntries: [] });
    expect(await applyPrivateGitignorePlan(repository, complete)).toEqual({
      status: "unchanged",
      added: [],
    });
    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe(after);
  });

  it("previews only missing lines in a partial file and refuses a changed preimage", async () => {
    const repository = await temporaryDirectories.create("docsfab-init-gitignore-");
    const path = join(repository, ".gitignore");
    await writeFile(path, "node_modules/\n.docsfab/\n", { mode: 0o644 });
    const plan = await inspectPrivateGitignorePlan(repository);
    expect(plan).toMatchObject({ action: "append", missingEntries: [".docsfab-init.*"] });
    await writeFile(path, "keep-this/\n.docsfab/\n", { mode: 0o644 });
    expect((await inspectPrivateGitignorePlan(repository)).preimageSha256).not.toBe(
      plan.preimageSha256,
    );
    expect(await applyPrivateGitignorePlan(repository, plan)).toMatchObject({
      status: "skipped",
      reason: "changed-after-approval",
      added: [],
    });
    expect(await readFile(path, "utf8")).toBe("keep-this/\n.docsfab/\n");
  });

  it("makes symlink and non-file skips explicit and preserves their targets", async () => {
    const repository = await temporaryDirectories.create("docsfab-init-gitignore-");
    const outside = join(repository, "outside-ignore");
    await writeFile(outside, "keep\n");
    await symlink(outside, join(repository, ".gitignore"));
    const plan = await inspectPrivateGitignorePlan(repository);
    expect(plan).toMatchObject({ action: "skip", reason: "unsafe-type" });
    expect(await applyPrivateGitignorePlan(repository, plan)).toMatchObject({
      status: "skipped",
      reason: "unsafe-type",
      added: [],
    });
    expect(await readFile(outside, "utf8")).toBe("keep\n");

    const directoryRepository = await temporaryDirectories.create("docsfab-init-gitignore-");
    await mkdir(join(directoryRepository, ".gitignore"));
    const directoryPlan = await inspectPrivateGitignorePlan(directoryRepository);
    expect(directoryPlan).toMatchObject({ action: "skip", reason: "unsafe-type" });
    expect(await applyPrivateGitignorePlan(directoryRepository, directoryPlan)).toMatchObject({
      status: "skipped",
      reason: "unsafe-type",
    });
  });

  it("does not overwrite a file created after an absent-file preview", async () => {
    const repository = await temporaryDirectories.create("docsfab-init-gitignore-");
    const plan = await inspectPrivateGitignorePlan(repository);
    await writeFile(join(repository, ".gitignore"), "concurrent/\n");
    expect(await applyPrivateGitignorePlan(repository, plan)).toMatchObject({
      status: "skipped",
      reason: "changed-after-approval",
      added: [],
    });
    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe("concurrent/\n");
  });

  it("accepts a complete file at the resolved byte bound and explains a bound-plus-one skip", async () => {
    const repository = await temporaryDirectories.create("docsfab-init-gitignore-");
    const path = join(repository, ".gitignore");
    const bound = limit("init.gitignoreMaxBytes");
    const required = ".docsfab/\n.docsfab-init.*\n";
    await writeFile(path, `${required}${"#".repeat(bound.value - Buffer.byteLength(required))}`);
    expect((await stat(path)).size).toBe(bound.value);
    expect(await inspectPrivateGitignorePlan(repository)).toMatchObject({
      action: "none",
      maxBytes: bound.value,
      maxBytesSource: bound.source,
    });

    await writeFile(
      path,
      `${required}${"#".repeat(bound.value + 1 - Buffer.byteLength(required))}`,
    );
    const oversized = await inspectPrivateGitignorePlan(repository);
    expect(oversized).toMatchObject({
      action: "skip",
      reason: "too-large",
      limitExceeded: {
        code: bound.refusal,
        observedBytes: bound.value + 1,
        configuredBytes: bound.value,
        scope: "selected repository .gitignore",
        remediation: bound.remediation,
      },
    });
    expect(await applyPrivateGitignorePlan(repository, oversized)).toMatchObject({
      status: "skipped",
      reason: "too-large",
      limitExceeded: oversized.limitExceeded,
    });
    expect((await stat(path)).size).toBe(bound.value + 1);
  });

  it("skips an append whose projected bytes exceed a validated host override", async () => {
    const repository = await temporaryDirectories.create("docsfab-init-gitignore-");
    const path = join(repository, ".gitignore");
    const environment = { DOCSFAB_INIT_GITIGNORE_MAX_BYTES: "4096" };
    const bound = limit("init.gitignoreMaxBytes", { environment });
    await writeFile(path, "#".repeat(bound.value));
    const planned = await inspectPrivateGitignorePlan(repository, environment);
    expect(planned).toMatchObject({
      action: "skip",
      reason: "too-large",
      missingEntries: [".docsfab/", ".docsfab-init.*"],
      maxBytes: bound.value,
      limitExceeded: {
        code: bound.refusal,
        observedBytes: bound.value + Buffer.byteLength("\n.docsfab/\n.docsfab-init.*\n"),
        configuredBytes: bound.value,
      },
    });
    expect(await applyPrivateGitignorePlan(repository, planned, environment)).toMatchObject({
      status: "skipped",
      reason: "too-large",
    });
    expect(await readFile(path, "utf8")).toBe("#".repeat(bound.value));
  });

  it("appends private-only entries when they are missing", async () => {
    const repository = await temporaryDirectories.create("docsfab-init-gitignore-");
    const created = await appendPrivateGitignoreFragment(repository);
    expect(created).toEqual({
      status: "created",
      added: [".docsfab/", ".docsfab-init.*"],
    });
    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe(
      ".docsfab/\n.docsfab-init.*\n",
    );

    await writeFile(join(repository, ".gitignore"), "node_modules/\n", { mode: 0o644 });
    const appended = await appendPrivateGitignoreFragment(repository);
    expect(appended).toEqual({
      status: "appended",
      added: [".docsfab/", ".docsfab-init.*"],
    });
    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.docsfab/\n.docsfab-init.*\n",
    );

    const again = await appendPrivateGitignoreFragment(repository);
    expect(again).toEqual({ status: "unchanged", added: [] });
    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.docsfab/\n.docsfab-init.*\n",
    );
  });

  it("does not clobber existing gitignore content", async () => {
    const repository = await temporaryDirectories.create("docsfab-init-gitignore-");
    const original = "# keep me\nnode_modules/\n*.log";
    await writeFile(join(repository, ".gitignore"), original, { mode: 0o644 });
    const result = await appendPrivateGitignoreFragment(repository);
    expect(result.status).toBe("appended");
    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe(
      `${original}\n.docsfab/\n.docsfab-init.*\n`,
    );

    const withPrivate = await readFile(join(repository, ".gitignore"), "utf8");
    const second = await appendPrivateGitignoreFragment(repository);
    expect(second.status).toBe("unchanged");
    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe(withPrivate);

    const outside = join(repository, "outside-ignore");
    await writeFile(outside, "secret-pattern\n", { mode: 0o644 });
    const linked = await temporaryDirectories.create("docsfab-init-gitignore-");
    await symlink(outside, join(linked, ".gitignore"));
    expect(await appendPrivateGitignoreFragment(linked)).toEqual({
      status: "skipped",
      added: [],
      reason: "unsafe-type",
    });
    expect(await readFile(outside, "utf8")).toBe("secret-pattern\n");
  });

  it("never ignores .docsfab.json", () => {
    expect(PRIVATE_GITIGNORE_ENTRIES).not.toContain(DOCSFAB_PROJECT_CONFIG_FILE);
    expect(
      PRIVATE_GITIGNORE_ENTRIES.every((entry) => !gitignoreLineIgnoresProjectConfig(entry)),
    ).toBe(true);
    expect(missingPrivateGitignoreEntries("")).toEqual([".docsfab/", ".docsfab-init.*"]);
    expect(missingPrivateGitignoreEntries("")).not.toContain(DOCSFAB_PROJECT_CONFIG_FILE);
    expect(missingPrivateGitignoreEntries(`${DOCSFAB_PROJECT_CONFIG_FILE}\n`)).toEqual([
      ".docsfab/",
      ".docsfab-init.*",
    ]);
    expect(() => assertPrivateOnlyGitignoreEntries([DOCSFAB_PROJECT_CONFIG_FILE])).toThrow(
      "must not gitignore the project file .docsfab.json",
    );
    expect(() => assertPrivateOnlyGitignoreEntries([".docsfab*"])).toThrow(
      "must not gitignore the project file .docsfab.json",
    );
    expect(gitignoreLineIgnoresProjectConfig(DOCSFAB_PROJECT_CONFIG_FILE)).toBe(true);
    expect(gitignoreLineIgnoresProjectConfig(".docsfab/")).toBe(false);
    expect(gitignoreLineIgnoresProjectConfig(".docsfab-init.*")).toBe(false);
  });

  it("does not add .docsfab.json even when an existing gitignore already names it", async () => {
    const repository = await temporaryDirectories.create("docsfab-init-gitignore-");
    await writeFile(join(repository, ".gitignore"), `${DOCSFAB_PROJECT_CONFIG_FILE}\n`, {
      mode: 0o644,
    });
    const before = await stat(join(repository, ".gitignore"));
    const result = await appendPrivateGitignoreFragment(repository);
    expect(result.added).not.toContain(DOCSFAB_PROJECT_CONFIG_FILE);
    const content = await readFile(join(repository, ".gitignore"), "utf8");
    const configLines = content
      .split(/\r?\n/u)
      .filter((line) => line.trim() === DOCSFAB_PROJECT_CONFIG_FILE);
    expect(configLines).toHaveLength(1);
    expect(content).toContain(".docsfab/");
    expect(content).toContain(".docsfab-init.*");
    expect(result.status).toBe("appended");
    expect(before.size).toBeLessThan((await stat(join(repository, ".gitignore"))).size);
  });
});
