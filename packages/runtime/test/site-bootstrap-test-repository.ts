// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function fixtureRepository(
  roots: string[],
): Promise<{ path: string; revision: string }> {
  const path = await mkdtemp(join(tmpdir(), "docsfab-site-bootstrap-source-"));
  roots.push(path);
  await execFileAsync("git", ["-C", path, "init", "--quiet"]);
  await execFileAsync("git", ["-C", path, "config", "user.email", "docsfab@example.test"]);
  await execFileAsync("git", ["-C", path, "config", "user.name", "DocsFab Test"]);
  await execFileAsync("git", ["-C", path, "config", "commit.gpgsign", "false"]);
  for (const file of [
    "operate/run.md",
    "operate/debug.md",
    "operate/index.md",
    "concepts/model.md",
    "concepts/policy.md",
    "concepts/index.md",
  ]) {
    const target = join(path, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `# ${file}\n\nFixture documentation.\n`, "utf8");
  }
  await execFileAsync("git", ["-C", path, "add", "."]);
  await execFileAsync("git", ["-C", path, "commit", "--quiet", "-m", "fixture"]);
  const result = await execFileAsync("git", ["-C", path, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  return { path, revision: result.stdout.trim() };
}
