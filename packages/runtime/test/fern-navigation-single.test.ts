// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observeFernNavigation } from "../src/repository/fern-navigation.js";
import {
  buildRepositoryDiscoveryInventory,
  decodeRepositoryDiscoveryInventory,
} from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { listTrackedRepositoryEntries } from "../src/repository/workspace/tracked-read.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";

const roots = temporaryRoots();
const navigation =
  "instances:\n  - url: https://docs.example.test/pilot\nnavigation:\n  - section: Guide\n    slug: guide\n    contents:\n      - page: Start\n        path: ../docs/guide.md\n        slug: start\n";
async function repository(source = navigation) {
  const root = await roots.create("docsfab-fern-single-", { realpath: true });
  await initFixtureRepo(
    root,
    { "fern/docs.yml": source, "docs/guide.md": "# Guide\n\nThe actual tracked guide.\n" },
    { message: "tracked Fern fixture" },
  );
  return { root };
}

it("authenticates unversioned Fern navigation and round-trips complete inventory evidence", async () => {
  const fixture = await repository();
  const workspace = await prepareRepositoryWorkspace(fixture.root, "HEAD");
  try {
    const observed = await observeFernNavigation({
      workspace,
      entries: await listTrackedRepositoryEntries(workspace),
    });
    expect(observed?.status).toBe("complete");
    expect(observed?.sources).toHaveLength(1);
    expect(observed?.sources[0]?.path).toBe("fern/docs.yml");
    expect(observed?.routes).toEqual([
      expect.objectContaining({
        sourcePath: "fern/docs.yml",
        path: "docs/guide.md",
        route: "/pilot/guide/start",
        sourceSha256: createHash("sha256").update(navigation).digest("hex"),
        targetSha256: createHash("sha256")
          .update(await readFile(join(fixture.root, "docs/guide.md")))
          .digest("hex"),
      }),
    ]);
    const inventory = await buildRepositoryDiscoveryInventory({ workspace });
    expect(inventory.coverage.navigation.status).toBe("complete");
    expect(inventory.navigation.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs/guide.md", route: "/pilot/guide/start" }),
      ]),
    );
    expect(decodeRepositoryDiscoveryInventory(JSON.parse(JSON.stringify(inventory)))).toEqual(
      inventory,
    );
  } finally {
    await workspace.dispose();
  }
});

it.each([
  [
    "missing target",
    navigation.replace("../docs/guide.md", "../docs/missing.md"),
    "target-missing",
  ],
  [
    "traversal",
    navigation.replace("../docs/guide.md", "../../outside.md"),
    "unsafe-navigation-path",
  ],
  [
    "mixed index",
    navigation + "versions:\n  - path: ./versions/current.yml\n",
    "malformed-navigation",
  ],
  [
    "alias",
    "navigation:\n  - &page\n    page: Guide\n    path: ../docs/guide.md\n  - *page\n",
    "malformed-navigation",
  ],
])(
  "refuses unversioned Fern %s without asserting complete navigation",
  async (_name, source, code) => {
    const fixture = await repository(source);
    const workspace = await prepareRepositoryWorkspace(fixture.root, "HEAD");
    try {
      const observed = await observeFernNavigation({
        workspace,
        entries: await listTrackedRepositoryEntries(workspace),
      });
      expect(observed?.status).toBe("incomplete");
      expect(observed?.failures).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.coverage.navigation.status).toBe("incomplete");
      expect(inventory.navigation.routes).toEqual([]);
    } finally {
      await workspace.dispose();
    }
  },
);

it("refuses linked and changed target bytes in unversioned Fern navigation", async () => {
  const fixture = await repository();
  await rm(join(fixture.root, "docs/guide.md"));
  await symlink("../fern/docs.yml", join(fixture.root, "docs/guide.md"));
  await commitFixture(fixture.root, "linked target");
  const linked = await prepareRepositoryWorkspace(fixture.root, "HEAD");
  try {
    const observed = await observeFernNavigation({
      workspace: linked,
      entries: await listTrackedRepositoryEntries(linked),
    });
    expect(observed?.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "target-unsafe" })]),
    );
  } finally {
    await linked.dispose();
  }
  const clean = await prepareRepositoryWorkspace(fixture.root, "HEAD~1");
  try {
    const entries = await listTrackedRepositoryEntries(clean);
    await writeFile(join(clean.path, "docs/guide.md"), "# Substituted\n");
    const observed = await observeFernNavigation({ workspace: clean, entries });
    expect(observed?.status).toBe("incomplete");
    expect(observed?.routes).toEqual([]);
    expect(observed?.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "target-changed" })]),
    );
  } finally {
    await clean.dispose();
  }
});
