// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareStandardSiteBootstrapChecks,
  standardSiteBootstrapCheckPolicy,
} from "../src/site-bootstrap/index.js";
import { runRepositoryChecks } from "../src/templates/checks.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("standard site-bootstrap repository policy", () => {
  it("is deterministic and validates bounded UTF-8 documentation", async () => {
    expect(standardSiteBootstrapCheckPolicy()).toEqual(standardSiteBootstrapCheckPolicy());
    const root = await mkdtemp(join(tmpdir(), "docsfab-site-policy-"));
    roots.push(root);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "index.md"), "# Documentation\n", "utf8");
    const report = await runRepositoryChecks({
      workspacePath: root,
      capability: await prepareStandardSiteBootstrapChecks(),
    });
    expect(report.status).toBe("passed");
  });

  it("fails on invalid UTF-8 and symlinked documentation entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-site-policy-bad-"));
    roots.push(root);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "invalid.md"), Buffer.from([0xff]));
    const capability = await prepareStandardSiteBootstrapChecks();
    expect((await runRepositoryChecks({ workspacePath: root, capability })).status).toBe("failed");

    await rm(join(root, "docs", "invalid.md"));
    await writeFile(join(root, "outside.md"), "# Outside\n", "utf8");
    await symlink(join(root, "outside.md"), join(root, "docs", "linked.md"));
    expect((await runRepositoryChecks({ workspacePath: root, capability })).status).toBe("failed");
  });
});
