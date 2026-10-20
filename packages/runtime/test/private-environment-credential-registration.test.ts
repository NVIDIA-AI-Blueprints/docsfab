// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPrivateDocsFabEnvironment } from "../src/config/private-environment.js";
import { persistHostedQualityReport } from "../src/evaluation-report/hosted-report.js";
import { egressText, egressValue, hostRootSet } from "../src/security/egress.js";
import {
  activateConfiguredCredentialMatchingDefaults,
  containsConfiguredCredential,
  createConfiguredCredentialRegistry,
  currentConfiguredCredentialMatchingPolicy,
  redactConfiguredCredentials,
  refreshConfiguredCredentials,
  uncomparedConfiguredCredentials,
} from "../src/security/configured-credentials.js";
import {
  inspectLimits,
  limitDefinition,
  loadEffectiveLimitEnvironment,
} from "../src/config/limits.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const minimum = limitDefinition("secrets.configuredCredentialMinChars");
const fragmentMinimum = limitDefinition("secrets.configuredCredentialFragmentChars");
const distinctMinimum = limitDefinition("secrets.configuredCredentialMinDistinctChars");

describe("private environment credential registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    activateConfiguredCredentialMatchingDefaults(process.env, {
      minChars: minimum.value,
      fragmentChars: fragmentMinimum.value,
      minDistinctChars: distinctMinimum.value,
    });
    refreshConfiguredCredentials();
  });

  it("registers exact-match arbitrary file-loaded secrets without persisting unchanged ambient entries", async () => {
    const root = await roots.create("docsfab-private-environment-");
    await chmod(root, 0o700);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const privateValue = ["ordinary", "file-loaded", "material", "moss", "harbor"].join("-");
    await writeFile(join(root, ".env"), `DOCSFAB_FIXTURE_PASSWORD=${privateValue}\n`, {
      mode: 0o600,
    });
    expect(containsConfiguredCredential(privateValue)).toBe(false);

    const effective = loadPrivateDocsFabEnvironment({ DOCSFAB_CONFIG_ROOT: root });

    expect(effective.DOCSFAB_FIXTURE_PASSWORD).toBe(privateValue);
    expect(containsConfiguredCredential(privateValue)).toBe(true);
    expect(redactConfiguredCredentials(`diagnostic ${privateValue}`)).toBe("diagnostic [REDACTED]");
    expect(egressText(`published ${privateValue}`, hostRootSet([]))).toEqual({
      ok: false,
      code: "credential-material",
    });

    const rotatedValue = ["ordinary", "rotated", "credential", "material", "river"].join("-");
    await writeFile(join(root, ".env"), `DOCSFAB_FIXTURE_PASSWORD=${rotatedValue}\n`, {
      mode: 0o600,
    });
    loadPrivateDocsFabEnvironment({ DOCSFAB_CONFIG_ROOT: root });
    expect(containsConfiguredCredential(privateValue)).toBe(true);
    expect(containsConfiguredCredential(rotatedValue)).toBe(true);
  });

  it("retains a private file credential whose value initially equals an ambient export", async () => {
    const root = await roots.create("docsfab-private-shared-credential-");
    await chmod(root, 0o700);
    const name = "DOCSFAB_FIXTURE_SHARED_PASSWORD";
    const value = ["shared", "ambient", "and", "private", "material", "harbor"].join("-");
    await writeFile(join(root, ".env"), `${name}=${value}\n`, { mode: 0o600 });
    vi.stubEnv(name, value);
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);

    const effective = loadPrivateDocsFabEnvironment();
    expect(effective[name]).toBe(value);
    expect(containsConfiguredCredential(value)).toBe(true);

    vi.stubEnv(name, undefined);
    refreshConfiguredCredentials();
    expect(containsConfiguredCredential(value)).toBe(true);
    expect(egressText(`published ${value}`, hostRootSet([]))).toMatchObject({
      ok: false,
      code: "credential-material",
    });
  });

  it("screens split secrets.env credentials through egress and the report publisher", async () => {
    const root = await roots.create("docsfab-private-split-credential-");
    await chmod(root, 0o700);
    await mkdir(join(root, "profiles"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, "host.yaml"),
      [
        "schemaVersion: 1",
        "kind: docsfab-host-config",
        "active:",
        "  writing:",
        "    compositionId: anthropic-claude-opus-4.7-pi",
        "    qualification: not-run",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const short = plantedCredentialValue(2047, minimum.min);
    await writeFile(
      join(root, "secrets.env"),
      `DOCSFAB_FIXTURE_SPLIT_PASSWORD=${short}\n${minimum.override}=${minimum.min}\n${distinctMinimum.override}=${distinctMinimum.min}\n`,
      { mode: 0o600 },
    );
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);

    const effective = loadPrivateDocsFabEnvironment();
    expect(effective.DOCSFAB_FIXTURE_SPLIT_PASSWORD).toBe(short);
    expect(containsConfiguredCredential(short)).toBe(true);
    expect(egressText(`ordinary ${short}`, hostRootSet([]))).toMatchObject({
      ok: false,
      code: "credential-material",
    });
    expect(egressValue({ markdown: `ordinary ${short}` }, hostRootSet([]))).toMatchObject({
      ok: false,
      code: "credential-material",
    });
    await expect(
      persistHostedQualityReport({
        stateDirectory: root,
        runId: "private-policy-split",
        quality: null,
        markdown: `ordinary ${short}`,
        environment: effective,
      }),
    ).rejects.toMatchObject({ name: "HostedQualityReportError", code: "credential-material" });
  });

  it("shares activated numeric policy and private registrations across module instances", async () => {
    const root = await roots.create("docsfab-private-shared-policy-");
    await chmod(root, 0o700);
    const short = plantedCredentialValue(2044, minimum.min);
    await writeFile(
      join(root, ".env"),
      `DOCSFAB_FIXTURE_SHARED_POLICY_PASSWORD=${short}\n${minimum.override}=${minimum.min}\n`,
      { mode: 0o600 },
    );
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    loadPrivateDocsFabEnvironment();
    expect(containsConfiguredCredential(short)).toBe(true);

    vi.resetModules();
    const otherModule = await import("../src/security/configured-credentials.js");
    expect(otherModule.containsConfiguredCredential(`published ${short}`)).toBe(true);
  });

  it("does not turn an unchanged ambient credential into a permanent registration", async () => {
    const root = await roots.create("docsfab-private-ambient-credential-");
    await chmod(root, 0o700);
    const ambient = plantedCredentialValue(2051, 32);
    vi.stubEnv("DOCSFAB_FIXTURE_AMBIENT_PASSWORD", ambient);

    loadPrivateDocsFabEnvironment({ DOCSFAB_CONFIG_ROOT: root });

    vi.unstubAllEnvs();
    activateConfiguredCredentialMatchingDefaults(process.env, {
      minChars: minimum.value,
      fragmentChars: fragmentMinimum.value,
      minDistinctChars: distinctMinimum.value,
    });
    refreshConfiguredCredentials();
    expect(containsConfiguredCredential(ambient)).toBe(false);
  });

  it("activates file comparator defaults for real egress and rejects injected policy mismatches before registration", async () => {
    const root = await roots.create("docsfab-private-credential-policy-");
    await chmod(root, 0o700);
    const short = plantedCredentialValue(2049, minimum.min);
    await writeFile(
      join(root, ".env"),
      `DOCSFAB_FIXTURE_POLICY_PASSWORD=${short}\n${minimum.override}=${minimum.min}\n`,
      { mode: 0o600 },
    );
    const before = containsConfiguredCredential(short);
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);

    const effective = loadPrivateDocsFabEnvironment();
    expect(effective[minimum.override!]).toBe(String(minimum.min));
    expect(containsConfiguredCredential(short)).toBe(true);
    expect(egressText(`ordinary ${short}`, hostRootSet([]))).toEqual({
      ok: false,
      code: "credential-material",
    });
    expect(egressText("ordinary release note", hostRootSet([])).ok).toBe(true);

    const anotherRoot = await roots.create("docsfab-private-credential-mismatch-");
    await chmod(anotherRoot, 0o700);
    const mismatchValue = plantedCredentialValue(2048, minimum.min);
    const prior = containsConfiguredCredential(mismatchValue);
    expect(() =>
      loadPrivateDocsFabEnvironment({
        DOCSFAB_CONFIG_ROOT: anotherRoot,
        [minimum.override!]: String(minimum.value),
        DOCSFAB_FIXTURE_MISMATCH_PASSWORD: mismatchValue,
      }),
    ).toThrow(/activate the host comparator policy/i);
    expect(containsConfiguredCredential(mismatchValue)).toBe(prior);
    expect(containsConfiguredCredential(short)).toBe(true);
    expect(before).toBe(false);
  });

  it("keeps exported precedence live and reevaluates retained credentials and doctor status", async () => {
    const root = await roots.create("docsfab-private-credential-policy-refresh-");
    await chmod(root, 0o700);
    const short = plantedCredentialValue(2046, minimum.min);
    const source = "environment variable DOCSFAB_FIXTURE_REFRESH_PASSWORD";
    await writeFile(
      join(root, ".env"),
      `DOCSFAB_FIXTURE_REFRESH_PASSWORD=${short}\n${minimum.override}=${minimum.min}\n`,
      { mode: 0o600 },
    );
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    // An exported current value wins at activation but is not frozen into the private defaults.
    vi.stubEnv(minimum.override!, String(minimum.value));
    const effective = loadPrivateDocsFabEnvironment();
    expect(effective[minimum.override!]).toBe(String(minimum.value));
    expect(currentConfiguredCredentialMatchingPolicy().minChars).toBe(minimum.value);
    const exportedLimits = await inspectLimits({
      environment: loadEffectiveLimitEnvironment(),
      cwd: root,
    });
    expect(exportedLimits.rows.find((row) => row.name === minimum.name)?.value).toBe(minimum.value);
    expect(containsConfiguredCredential(short)).toBe(false);
    expect(uncomparedConfiguredCredentials(effective)).toContainEqual(
      expect.objectContaining({ source, rule: "shorter-than-minimum", limitValue: minimum.value }),
    );

    vi.stubEnv(minimum.override!, undefined);
    refreshConfiguredCredentials();
    expect(currentConfiguredCredentialMatchingPolicy().minChars).toBe(minimum.min);
    const privateDefaultLimits = await inspectLimits({
      environment: loadEffectiveLimitEnvironment(),
      cwd: root,
    });
    expect(privateDefaultLimits.rows.find((row) => row.name === minimum.name)?.value).toBe(
      minimum.min,
    );
    expect(containsConfiguredCredential(short)).toBe(true);
    expect(uncomparedConfiguredCredentials(process.env)).not.toContainEqual(
      expect.objectContaining({ source, rule: "shorter-than-minimum" }),
    );

    vi.stubEnv(minimum.override!, String(minimum.value));
    refreshConfiguredCredentials();
    expect(containsConfiguredCredential(short)).toBe(false);
    expect(uncomparedConfiguredCredentials(process.env)).toContainEqual(
      expect.objectContaining({ source, rule: "shorter-than-minimum", limitValue: minimum.value }),
    );
  });

  it("leaves the active policy and shared registrations unchanged when host activation is invalid", async () => {
    const root = await roots.create("docsfab-private-credential-invalid-policy-");
    await chmod(root, 0o700);
    const secret = plantedCredentialValue(2045, minimum.min);
    await writeFile(
      join(root, ".env"),
      `DOCSFAB_FIXTURE_INVALID_PASSWORD=${secret}\n${minimum.override}=not-a-number\n`,
      { mode: 0o600 },
    );
    const before = currentConfiguredCredentialMatchingPolicy();
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);

    expect(() => loadPrivateDocsFabEnvironment()).toThrow(
      /DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_MIN_CHARS/,
    );
    expect(currentConfiguredCredentialMatchingPolicy()).toEqual(before);
    expect(containsConfiguredCredential(secret)).toBe(false);
  });

  it("rejects an invalid exported override after a valid file default without changing shared state", async () => {
    const root = await roots.create("docsfab-private-credential-export-policy-");
    await chmod(root, 0o700);
    const secret = plantedCredentialValue(2051, minimum.min);
    await writeFile(
      join(root, ".env"),
      `DOCSFAB_FIXTURE_EXPORT_PASSWORD=${secret}\n${minimum.override}=${minimum.min}\n`,
      { mode: 0o600 },
    );
    const before = currentConfiguredCredentialMatchingPolicy();
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    vi.stubEnv(minimum.override!, "not-a-number");

    expect(() => loadPrivateDocsFabEnvironment()).toThrow(
      /DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_MIN_CHARS/,
    );
    vi.stubEnv(minimum.override!, undefined);
    expect(currentConfiguredCredentialMatchingPolicy()).toEqual(before);
    expect(containsConfiguredCredential(secret)).toBe(false);
  });

  it("refreshes private loader diagnostics under the effective credential limits", async () => {
    const root = await roots.create("docsfab-private-credential-limits-");
    await chmod(root, 0o700);
    const short = plantedCredentialValue(2050, minimum.min);
    expect(short.length).toBeLessThan(minimum.value);
    expect(containsConfiguredCredential(short)).toBe(false);
    const source = "environment variable DOCSFAB_FIXTURE_PRIVATE_PASSWORD";
    await writeFile(join(root, ".env"), `DOCSFAB_FIXTURE_PRIVATE_PASSWORD=${short}\n`, {
      mode: 0o600,
    });

    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    const defaultEnvironment = loadPrivateDocsFabEnvironment();
    expect(uncomparedConfiguredCredentials(defaultEnvironment)).toContainEqual(
      expect.objectContaining({ source, rule: "shorter-than-minimum" }),
    );

    vi.stubEnv(minimum.override!, String(minimum.min));
    const overriddenEnvironment = loadPrivateDocsFabEnvironment();
    expect(uncomparedConfiguredCredentials(overriddenEnvironment)).not.toContainEqual(
      expect.objectContaining({ source, rule: "shorter-than-minimum" }),
    );
    const effectiveRegistry = createConfiguredCredentialRegistry({
      environment: () => overriddenEnvironment,
      sharedRegistrations: true,
    });
    expect(effectiveRegistry.find(short)?.source).toBe(source);
    expect(effectiveRegistry.redact(`diagnostic ${short}`)).toBe("diagnostic [REDACTED]");
  });
});
