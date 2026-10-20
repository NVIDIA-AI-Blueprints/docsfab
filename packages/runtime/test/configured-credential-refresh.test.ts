// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  containsConfiguredCredential,
  createConfiguredCredentialRegistry,
  findConfiguredCredential,
  refreshConfiguredCredentials,
} from "../src/security/configured-credentials.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

// Values built at run time, a different seed for each, so no two share a
// piece a match could find and no value one test leaves in the process
// registry can satisfy another.
const planted = (seed: number) => plantedCredentialValue(seed, 24);

describe("configured credential files after a refresh (#1807)", () => {
  const roots = temporaryRoots();

  afterEach(() => {
    vi.unstubAllEnvs();
    refreshConfiguredCredentials();
  });

  it("reads a credential file rewritten in place again after refresh(), and still matches the value it held", async () => {
    const root = await roots.create("docsfab-credential-rotation-");
    const path = join(root, "token");
    const before = planted(1101);
    const after = planted(1102);
    await writeFile(path, `${before}\n`);
    const variables: NodeJS.ProcessEnv = { DOCSFAB_FIXTURE_TOKEN_FILE: path };
    const registry = createConfiguredCredentialRegistry({ environment: () => variables });
    const source = "credential file named by DOCSFAB_FIXTURE_TOKEN_FILE";
    expect(registry.find(`x ${before}`)).toMatchObject({ source, form: "value" });

    await writeFile(path, `${after}\n`);
    // Without a refresh, a check keeps the reading it has: the file is read
    // again at the next refresh, not at every check.
    expect(registry.find(`x ${after}`)).toBeNull();

    registry.refresh();
    expect(registry.find(`x ${after}`)).toMatchObject({ source, form: "value" });
    // The rotated-out value can still be valid, so it stays matched.
    expect(registry.find(`x ${before}`)).toMatchObject({ source, form: "value" });
    expect(registry.inventory()).toEqual([{ source, status: "screened" }]);

    // It stays matched after the variable no longer names the file, too.
    delete variables.DOCSFAB_FIXTURE_TOKEN_FILE;
    registry.refresh();
    expect(registry.inventory()).toEqual([]);
    expect(registry.find(`x ${before}`)).toMatchObject({ source, form: "value" });
    expect(registry.find(`x ${after}`)).toMatchObject({ source, form: "value" });
  });

  it("lists the systemd credentials directory again after refresh(), so a new file is matched", async () => {
    const root = await roots.create("docsfab-credential-directory-");
    const directory = join(root, "credentials");
    await mkdir(directory);
    const first = planted(1103);
    const added = planted(1104);
    await writeFile(join(directory, "first-credential"), first);
    const registry = createConfiguredCredentialRegistry({
      environment: () => ({ CREDENTIALS_DIRECTORY: directory }),
    });
    expect(registry.find(`x ${first}`)?.source).toBe("systemd credential first-credential");

    await writeFile(join(directory, "added-credential"), added);
    expect(registry.find(`x ${added}`)).toBeNull();

    registry.refresh();
    expect(registry.find(`x ${added}`)).toMatchObject({
      source: "systemd credential added-credential",
      form: "value",
    });
    expect(registry.inventory()).toEqual([
      { source: "systemd credential added-credential", status: "screened" },
      { source: "systemd credential first-credential", status: "screened" },
    ]);

    // A credential removed from the directory still matches.
    await rm(join(directory, "first-credential"));
    registry.refresh();
    expect(registry.inventory()).toEqual([
      { source: "systemd credential added-credential", status: "screened" },
    ]);
    expect(registry.find(`x ${first}`)?.source).toBe("systemd credential first-credential");
  });

  it("keeps the process registry's file reading for the rest of the turn without a refresh, and rereads it after one", async () => {
    const root = await roots.create("docsfab-credential-turn-");
    const path = join(root, "token");
    const before = planted(1105);
    const after = planted(1106);
    await writeFile(path, before);
    vi.stubEnv("DOCSFAB_FIXTURE_TURN_ROTATION_TOKEN_FILE", path);
    refreshConfiguredCredentials();
    expect(containsConfiguredCredential(`x ${before}`)).toBe(true);

    // The same synchronous run: a check without a refresh changes nothing.
    writeFileSync(path, after);
    expect(containsConfiguredCredential(`x ${after}`)).toBe(false);
    expect(containsConfiguredCredential(`x ${before}`)).toBe(true);

    refreshConfiguredCredentials();
    expect(findConfiguredCredential(`x ${after}`)).toMatchObject({
      source: "credential file named by DOCSFAB_FIXTURE_TURN_ROTATION_TOKEN_FILE",
      form: "value",
    });
    expect(containsConfiguredCredential(`x ${before}`)).toBe(true);
  });

  it("rereads files in every module instance when any instance refreshes", async () => {
    const root = await roots.create("docsfab-credential-instances-");
    const path = join(root, "token");
    const before = planted(1107);
    const after = planted(1108);
    await writeFile(path, before);
    vi.stubEnv("DOCSFAB_FIXTURE_INSTANCE_ROTATION_TOKEN_FILE", path);
    vi.resetModules();
    const other = await import("../src/security/configured-credentials.js");
    expect(other.findConfiguredCredential).not.toBe(findConfiguredCredential);
    refreshConfiguredCredentials();
    expect(other.containsConfiguredCredential(`x ${before}`)).toBe(true);

    writeFileSync(path, after);
    expect(other.containsConfiguredCredential(`x ${after}`)).toBe(false);
    // The refresh goes through this instance; the other one reads the file again.
    refreshConfiguredCredentials();
    expect(other.containsConfiguredCredential(`x ${after}`)).toBe(true);
    expect(other.containsConfiguredCredential(`x ${before}`)).toBe(true);
  });
});
