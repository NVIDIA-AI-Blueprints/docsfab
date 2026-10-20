// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CLI entry point, run in process against the Orbit editorial fixture's run
 * store (#2366). `main()` takes no command-runner seam, so GitLab's answers come
 * from a fake `glab` program first on PATH; Git runs for real.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { vi } from "vitest";

import { main } from "../../src/cli/router.js";
import { toOperatorErrorEnvelope } from "../../src/operator/error-envelope.js";
import { resetStartupPublicRootsForTest } from "../../src/security/host-roots.js";

/**
 * `glab` for the Orbit fixture project, as a program. It gives the answers that
 * the Orbit fixture's in-process `OrbitGitLabCommands` gives and refuses
 * everything else.
 */
export const FAKE_ORBIT_GLAB = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
const key = args.join(" ");
const base = "api --hostname gitlab.example.invalid ";
function reply(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
  process.exit(0);
}
if (key === "version") {
  process.stdout.write("glab 1.0\n");
  process.exit(0);
}
if (key === "auth status --hostname gitlab.example.invalid") process.exit(0);
if (key === "config get token --host gitlab.example.invalid") process.exit(0);
if (key === base + "user") {
  reply({ username: "maintainer", name: "Maintainer", email: "maintainer@example.invalid" });
}
if (args[0] === "api" && args[3] === "graphql") {
  reply({ data: { project: { id: "gid://gitlab/Project/7", fullPath: "docs/orbit" } } });
}
if (key === base + "projects/7") {
  reply({
    id: 7,
    path_with_namespace: "docs/orbit",
    default_branch: "main",
    permissions: { project_access: { access_level: 40 }, group_access: null },
  });
}
if (key === base + "projects/7/repository/branches/main") {
  reply({ name: "main", protected: true, commit: { id: process.env.ORBIT_TARGET_REVISION } });
}
if (key.startsWith(base + "projects/7/protected_branches?per_page=100")) reply([{ name: "main" }]);
process.stderr.write("fake glab: refused\n");
process.exit(1);
`;

/** What the CLI run needs of the Orbit fixture: its run store and its target revision. */
export interface OrbitCliFixture {
  readonly head: string;
  readonly config: { readonly stateDirectory: string };
}

/**
 * Run the CLI entry point in process with `args` against the fixture's run
 * store and the fake `glab` above, and return what it logged. It restores the
 * process arguments, environment and console on the way out.
 */
export async function runOrbitCli(
  fixture: OrbitCliFixture,
  args: readonly string[],
): Promise<string[]> {
  const root = dirname(fixture.config.stateDirectory);
  const bin = join(root, "bin");
  const configurationRoot = join(root, "config");
  await mkdir(bin, { recursive: true });
  await mkdir(configurationRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(bin, "glab"), FAKE_ORBIT_GLAB);
  await chmod(join(bin, "glab"), 0o755);
  const originalArgv = process.argv;
  const lines: string[] = [];
  try {
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("DOCSFAB_STATE_DIR", fixture.config.stateDirectory);
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", configurationRoot);
    vi.stubEnv("ORBIT_TARGET_REVISION", fixture.head);
    process.argv = [originalArgv[0]!, originalArgv[1]!, ...args];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    await main();
    return lines;
  } finally {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetStartupPublicRootsForTest();
  }
}

/** The operator-visible code of the refusal `run` ends in, or `none` when it does not refuse. */
export async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return toOperatorErrorEnvelope(error).code;
  }
  return "none";
}
