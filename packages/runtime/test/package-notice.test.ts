// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const notice = readFileSync(join(projectRoot, "../../NOTICE"), "utf8");

type ShrinkwrapEntry = { version?: string; license?: string; dev?: boolean; devOptional?: boolean };
const shrinkwrap = JSON.parse(readFileSync(join(projectRoot, "npm-shrinkwrap.json"), "utf8")) as {
  packages: Record<string, ShrinkwrapEntry>;
};

// Platform-optional packages absent from this install are not checked here.
function installedApacheRuntimeDependencies(): { name: string; directory: string }[] {
  return Object.entries(shrinkwrap.packages)
    .filter(
      ([path, entry]) =>
        path !== "" && !entry.dev && !entry.devOptional && entry.license === "Apache-2.0",
    )
    .map(([path]) => ({
      name: path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
      directory: join(projectRoot, path),
    }))
    .filter(({ directory }) => existsSync(directory));
}

describe("repository NOTICE", () => {
  it("names the copyright holder and the Apache-2.0 license", () => {
    expect(notice).toContain("NVIDIA CORPORATION & AFFILIATES");
    expect(notice).toContain("Apache License, Version 2.0");
  });

  it("reproduces every NOTICE shipped by an Apache-2.0 runtime dependency", () => {
    const unreproduced = installedApacheRuntimeDependencies()
      .filter(({ directory }) =>
        readdirSync(directory).some((file) => /^notice(\.|$)/iu.test(file)),
      )
      .map(({ name }) => name)
      .filter((name) => !notice.includes(name));
    expect(unreproduced).toEqual([]);
  });
});
