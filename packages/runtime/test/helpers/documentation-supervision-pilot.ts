// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public replacement for documentation-supervision-pilot.ts. These disposable
 * repository inputs are newly authored for portable required-check coverage.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initFixtureRepo } from "./git.js";
export { recordingAuthority } from "./recording-check-authority.js";

export const PILOT_REQUIRED_CHECK = "python3 -m unittest discover -s tests";
export const RECORDED_PLANNER_STOP =
  `A proposed edit requires the repository check ${PILOT_REQUIRED_CHECK}; ` +
  "this planning step has no execution receipt for that check.";
export const PILOT_CLI = Object.freeze({
  title: "Inspect a folder locally",
  module: "src.local_inspector",
  source: "src/local_inspector.py:1",
  staleOption: "--legacy-path",
  currentOption: "--path",
  packageName: "local-folder-manual",
  moduleName: "local_inspector",
  corrected:
    "# Inspect a folder locally\n\n## Select a folder\n\nUse Python 3 from the project directory.\n\nRun `python3 -m src.local_inspector --path .`.\n\nCheck the repository with `python3 -m unittest discover -s tests`.\n",
});

const INSTRUCTIONS =
  "# Repository checks\n\nRun `python3 -m unittest discover -s tests` before proposing a documentation edit.\n";
const REQUEST =
  "Revise docs/cli.md so its option agrees with src/local_inspector.py. Keep the change confined to the guide and verify the repository check.";
const FILES = {
  "AGENTS.md": INSTRUCTIONS,
  "README.md":
    "# Local folder inspection\n\nRead the [command guide](docs/cli.md) before selecting a folder.\n",
  "docs/cli.md":
    "# Inspect a folder locally\n\n## Select a folder\n\nRun `python3 -m src.local_inspector --legacy-path .`.\n",
  "src/__init__.py": "",
  "src/local_inspector.py":
    "import argparse\n\ndef describe(path):\n    return 'Selected folder: ' + path\n\ndef main():\n    parser = argparse.ArgumentParser()\n    parser.add_argument('--path', required=True)\n    print(describe(parser.parse_args().path))\n\nif __name__ == '__main__':\n    main()\n",
  "tests/test_local_inspector.py":
    "import unittest\nfrom src.local_inspector import describe\n\nclass FolderDescriptionTests(unittest.TestCase):\n    def test_current_directory(self):\n        self.assertEqual(describe('.'), 'Selected folder: .')\n\n    def test_named_directory(self):\n        self.assertEqual(describe('manual'), 'Selected folder: manual')\n",
};

export async function requiredCheckInstructions(): Promise<string> {
  return INSTRUCTIONS;
}

export async function documentationUpdateRequest(): Promise<string> {
  return REQUEST;
}

/** Build a fresh local repository without reading retained qualification data. */
export async function materializePilotHead(): Promise<{ root: string; repository: string }> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-portable-required-checks-"));
  const repository = join(root, "repository");
  await initFixtureRepo(repository, FILES, { message: "portable required-check repository" });
  return { root, repository };
}
