// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { limit } from "../src/config/limits.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const script = fileURLToPath(new URL("../scripts/wsl2-qualification.mjs", import.meta.url));
const isWsl2 = process.platform === "linux" && /microsoft.*WSL2/i.test(release());

describe("WSL2 qualification candidate input", () => {
  it.each(["direct", "symlink"])(
    "refuses an unsafe retained candidate through %s invocation",
    async (kind) => {
      let invocation = script;
      if (kind === "symlink") {
        invocation = join(await roots.create("docsfab-wsl-candidate-"), "qualification.mjs");
        await symlink(script, invocation);
      }
      await expect(
        promisify(execFile)(process.execPath, [invocation, "--artifact-dir", "../untrusted"], {
          timeout: limit("test.ciTimeoutMs").value,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "expected no arguments or --artifact-dir <safe package-relative leaf>",
        ),
      });
    },
  );
});

describe.skipIf(!isWsl2)("WSL2 retained candidate at the installed proof entry point", () => {
  it.each(["direct", "symlink"])(
    "refuses invalid selected metadata instead of packing a replacement through %s invocation",
    async (kind) => {
      const leaf = `wsl-candidate-test-${randomUUID()}`;
      const candidate = fileURLToPath(new URL(`../${leaf}`, import.meta.url));
      await mkdir(candidate);
      try {
        await writeFile(join(candidate, "metadata.json"), "{}");
        await writeFile(join(candidate, "docsfab.tgz"), "invalid candidate");
        let invocation = script;
        if (kind === "symlink") {
          invocation = join(await roots.create("docsfab-wsl-retained-"), "qualification.mjs");
          await symlink(script, invocation);
        }
        await expect(
          promisify(execFile)(process.execPath, [invocation, "--artifact-dir", leaf], {
            timeout: limit("test.ciTimeoutMs").value,
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("metadata schema is invalid"),
        });
      } finally {
        await rm(candidate, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(isWsl2)("WSL2 qualification entry point on other hosts", () => {
  it.each(["direct", "symlink"])(
    "refuses %s invocation instead of silently succeeding",
    async (kind) => {
      let invocation = script;
      if (kind === "symlink") {
        invocation = join(await roots.create("docsfab-wsl-entry-"), "qualification.mjs");
        await symlink(script, invocation);
      }
      await expect(
        promisify(execFile)(process.execPath, [invocation], {
          timeout: limit("test.ciTimeoutMs").value,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "WSL2 qualification requires Linux Node on a real WSL2 host",
        ),
      });
    },
  );
});
