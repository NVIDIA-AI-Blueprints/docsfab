// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { limitDefinition } from "./limits.js";
import {
  containsConfiguredCredential,
  currentConfiguredCredentialMatchingPolicy,
} from "../security/configured-credentials.js";
import { isNonInferenceRuntimeConfig, loadNonInferenceRuntimeConfig } from "./runtime-loader.js";

describe("non-inference runtime configuration", () => {
  it("loads state and governed assets without a model or judge profile", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-audit-config-"));
    try {
      const config = loadNonInferenceRuntimeConfig({ DOCSFAB_CONFIG_ROOT: root });
      expect(isNonInferenceRuntimeConfig(config)).toBe(true);
      expect(config.stateDirectory).toBe(join(root, ".docsfab", "runs"));
      expect(config.skillCrateDirectory).toContain("skill-crate");
      expect(config.retryPolicy.maxRetries).toBeGreaterThanOrEqual(0);
      expect(config).not.toHaveProperty("model");
      expect(config).not.toHaveProperty("judge");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains host policy and refuses malformed host configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-audit-host-"));
    try {
      const hostPath = join(root, "host.yaml");
      writeFileSync(
        hostPath,
        "schemaVersion: 1\nkind: docsfab-host-config\nactiveExecutionProfile: nvidia-inference-gpt-6-sol-pi\npaths:\n  stateDir: ./audit-runs\nretryPolicy:\n  readOnlyMaxRetries: 2\n",
      );
      const config = loadNonInferenceRuntimeConfig({ DOCSFAB_CONFIG_ROOT: root });
      expect(config.stateDirectory).toBe(join(root, "audit-runs"));
      expect(config.retryPolicy.maxRetries).toBe(2);
      expect(config).not.toHaveProperty("model");
      writeFileSync(hostPath, "schemaVersion: 99\nkind: docsfab-host-config\n");
      expect(() => loadNonInferenceRuntimeConfig({ DOCSFAB_CONFIG_ROOT: root })).toThrow(
        "schemaVersion 1",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a host tool-output override without exposing file configuration in process.env", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-audit-effective-env-"));
    const priorRoot = process.env.DOCSFAB_CONFIG_ROOT;
    const priorCap = process.env.DOCSFAB_TOOL_OUTPUT_CAP_BYTES;
    try {
      writeFileSync(join(root, ".env"), "DOCSFAB_TOOL_OUTPUT_CAP_BYTES=4096\n");
      process.env.DOCSFAB_CONFIG_ROOT = root;
      delete process.env.DOCSFAB_TOOL_OUTPUT_CAP_BYTES;
      const config = loadNonInferenceRuntimeConfig();
      expect(config.toolOutputCapBytes).toBe(4096);
      expect(process.env.DOCSFAB_TOOL_OUTPUT_CAP_BYTES).toBeUndefined();
    } finally {
      if (priorRoot === undefined) delete process.env.DOCSFAB_CONFIG_ROOT;
      else process.env.DOCSFAB_CONFIG_ROOT = priorRoot;
      if (priorCap === undefined) delete process.env.DOCSFAB_TOOL_OUTPUT_CAP_BYTES;
      else process.env.DOCSFAB_TOOL_OUTPUT_CAP_BYTES = priorCap;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a private evidence-git bound for the audit collector", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-audit-evidence-limits-"));
    const priorRoot = process.env.DOCSFAB_CONFIG_ROOT;
    const priorOutput = process.env.DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES;
    try {
      writeFileSync(join(root, ".env"), "DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES=16\n");
      process.env.DOCSFAB_CONFIG_ROOT = root;
      delete process.env.DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES;
      const config = loadNonInferenceRuntimeConfig();
      expect(config.repositoryEvidenceGitLimits.outputMaxBytes.value).toBe(16);
      expect(process.env.DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES).toBeUndefined();
    } finally {
      if (priorRoot === undefined) delete process.env.DOCSFAB_CONFIG_ROOT;
      else process.env.DOCSFAB_CONFIG_ROOT = priorRoot;
      if (priorOutput === undefined)
        delete process.env.DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES;
      else process.env.DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES = priorOutput;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers private audit credentials for screening without requiring a model", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-audit-private-credential-"));
    const name = "DOCSFAB_AUDIT_FIXTURE_PASSWORD";
    const secret = "audit-private-credential-material-bayleaf-2046";
    const prior = process.env[name];
    try {
      delete process.env[name];
      writeFileSync(join(root, ".env"), `${name}=${secret}\n`);
      expect(containsConfiguredCredential(secret)).toBe(false);

      const config = loadNonInferenceRuntimeConfig({ DOCSFAB_CONFIG_ROOT: root });

      expect(config.execution).toBe("without-inference");
      expect(config).not.toHaveProperty("model");
      expect(process.env[name]).toBeUndefined();
      expect(containsConfiguredCredential(secret)).toBe(true);
    } finally {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an invalid exported matching policy before activating or registering audit credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-audit-invalid-policy-"));
    const minimum = limitDefinition("secrets.configuredCredentialMinChars");
    const secret = "violet-otter-wharf-pinecone-magnet-7159";
    const priorRoot = process.env.DOCSFAB_CONFIG_ROOT;
    const priorOverride = process.env[minimum.override!];
    const before = currentConfiguredCredentialMatchingPolicy();
    try {
      writeFileSync(
        join(root, ".env"),
        `DOCSFAB_AUDIT_INVALID_PASSWORD=${secret}\n${minimum.override}=${minimum.min}\n`,
      );
      process.env.DOCSFAB_CONFIG_ROOT = root;
      process.env[minimum.override!] = "not-a-number";

      expect(containsConfiguredCredential(secret)).toBe(false);
      expect(() => loadNonInferenceRuntimeConfig()).toThrow(minimum.override!);
      if (priorOverride === undefined) delete process.env[minimum.override!];
      else process.env[minimum.override!] = priorOverride;
      expect(currentConfiguredCredentialMatchingPolicy()).toEqual(before);
      expect(containsConfiguredCredential(secret)).toBe(false);
    } finally {
      if (priorRoot === undefined) delete process.env.DOCSFAB_CONFIG_ROOT;
      else process.env.DOCSFAB_CONFIG_ROOT = priorRoot;
      if (priorOverride === undefined) delete process.env[minimum.override!];
      else process.env[minimum.override!] = priorOverride;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
