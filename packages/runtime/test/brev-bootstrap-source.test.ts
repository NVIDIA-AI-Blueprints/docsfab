// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { MINIMUM_NODE_VERSION } from "../src/launcher.js";

const BOOTSTRAP = fileURLToPath(new URL("../deployment/brev/bootstrap.sh", import.meta.url));
const SOURCE_URL = "ssh://git@git.example.com/docs/product.git";
const REFUSAL = "DOCSFAB_GIT_URL is required";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Stubs every external command bootstrap.sh reaches so no package manager,
// network, or real Git runs; each call is appended to a log. The node stub
// reports `nodeVersion`; a sudo apt-get install of nodejs switches it to
// NODE_AFTER_INSTALL when that is set.
function sandbox(nodeVersion = "99.0.0"): { home: string; log: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "docsfab-brev-bootstrap-"));
  roots.push(root);
  const stubs = join(root, "stubs");
  const home = join(root, "home");
  const log = join(root, "calls.log");
  const versionFile = join(root, "node-version");
  mkdirSync(stubs);
  mkdirSync(home);
  writeFileSync(log, "");
  writeFileSync(versionFile, nodeVersion);
  const stub = (name: string, body = "") => {
    const path = join(stubs, name);
    writeFileSync(
      path,
      `#!/bin/bash\nprintf '%s\\n' "${name} $*" >>"$STUB_LOG"\n${body}\nexit 0\n`,
    );
    chmodSync(path, 0o755);
  };
  for (const name of ["curl", "rg", "bwrap", "tar", "npm", "apt-get"]) stub(name);
  stub(
    "sudo",
    `[[ "$*" == *"apt-get install"*nodejs* && -n "\${NODE_AFTER_INSTALL:-}" ]] && printf '%s' "$NODE_AFTER_INSTALL" >"$NODE_VERSION_FILE"`,
  );
  stub(
    "node",
    `case "$1" in -p) cat "$NODE_VERSION_FILE" ;; -v) printf 'v%s\\n' "$(cat "$NODE_VERSION_FILE")" ;; esac`,
  );
  stub(
    "git",
    `[[ "$1" == clone ]] && mkdir -p "$3/.git"\n[[ "$*" == *rev-parse* ]] && echo ${"0".repeat(40)}`,
  );
  return {
    home,
    log,
    env: {
      PATH: `${stubs}:/usr/bin:/bin`,
      HOME: home,
      STUB_LOG: log,
      NODE_VERSION_FILE: versionFile,
      LANG: "C",
    },
  };
}

function run(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [BOOTSTRAP], { env, encoding: "utf8" });
}

function calls(log: string): string[] {
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

describe("Brev bootstrap source repository", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("refuses a fresh clone with DOCSFAB_GIT_URL %s before installing anything", (_, url) => {
    const { home, log, env } = sandbox();
    const result = run(url === undefined ? env : { ...env, DOCSFAB_GIT_URL: url });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(REFUSAL);
    expect(result.stderr).toContain(join(home, "docsfab"));
    expect(calls(log)).toEqual([]);
    expect(existsSync(join(home, "docsfab"))).toBe(false);
  });

  it("refuses a leftover clone directory without .git when DOCSFAB_GIT_URL is unset before installing anything", () => {
    const { home, log, env } = sandbox();
    // A non-empty directory, as an interrupted install can leave behind.
    mkdirSync(join(home, "docsfab"));
    writeFileSync(join(home, "docsfab", "package.json"), "{}");
    const result = run(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(REFUSAL);
    expect(result.stderr).toContain(join(home, "docsfab"));
    expect(calls(log)).toEqual([]);
  });

  it("clones from the configured DOCSFAB_GIT_URL", () => {
    const { home, log, env } = sandbox();
    const result = run({ ...env, DOCSFAB_GIT_URL: SOURCE_URL });
    expect(result.stderr).not.toContain(REFUSAL);
    expect(result.status, result.stderr).toBe(0);
    expect(calls(log)).toContain(`git clone ${SOURCE_URL} ${join(home, "docsfab")}`);
  });

  it("updates an existing clone without DOCSFAB_GIT_URL", () => {
    const { home, log, env } = sandbox();
    mkdirSync(join(home, "docsfab", ".git"), { recursive: true });
    const result = run(env);
    expect(result.stderr).not.toContain(REFUSAL);
    expect(result.status, result.stderr).toBe(0);
    const gitCalls = calls(log).filter((line) => line.startsWith("git "));
    expect(gitCalls).toContain(`git -C ${join(home, "docsfab")} fetch --all --tags`);
    expect(gitCalls.some((line) => line.startsWith("git clone"))).toBe(false);
  });
});

// A release just below `version` on the same major line, or a release on
// the previous major when `version` is X.0.0.
function releaseBelow(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.99`;
  return `${major - 1}.99.99`;
}

describe("Brev bootstrap Node floor", () => {
  const floor = MINIMUM_NODE_VERSION;
  const major = Number(floor.split(".")[0]);
  const nodeSource = `curl -fsSL https://deb.nodesource.com/setup_${major}.x`;
  const below = releaseBelow(floor);

  // Like the launcher, a pre-release or build suffix is ignored, including on
  // the component that decides the comparison.
  it.each([floor, `${major + 2}.0.0`, `${major + 2}.0.0-nightly`, `${floor}-rc.1`])(
    "keeps an installed Node %s without installing",
    (version) => {
      const { log, env } = sandbox(version);
      const result = run({ ...env, DOCSFAB_GIT_URL: SOURCE_URL });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toMatch(/syntax error|arithmetic|unbound/u);
      expect(result.stdout).toContain(`Node.js v${version} ok`);
      expect(calls(log)).not.toContain(nodeSource);
    },
  );

  it.each([below, `${major - 1}.99.99`, "not-a-version"])(
    "refuses Node %s when the NodeSource install leaves it below the floor",
    (version) => {
      const { log, env } = sandbox(version);
      const result = run({ ...env, DOCSFAB_GIT_URL: SOURCE_URL });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Node.js v${version} is older than ${floor}`);
      expect(result.stderr).toContain(
        `Node.js ${floor} or later required; found v${version}. Install it manually, then re-run.`,
      );
      expect(calls(log)).toContain(nodeSource);
      expect(calls(log).some((line) => line.startsWith("git clone"))).toBe(false);
    },
  );

  it("continues after the NodeSource install raises Node to the floor", () => {
    const { log, env } = sandbox(below);
    const result = run({ ...env, DOCSFAB_GIT_URL: SOURCE_URL, NODE_AFTER_INSTALL: floor });
    expect(result.status, result.stderr).toBe(0);
    expect(calls(log)).toContain(nodeSource);
    expect(calls(log).some((line) => line.startsWith("git clone"))).toBe(true);
  });
});
