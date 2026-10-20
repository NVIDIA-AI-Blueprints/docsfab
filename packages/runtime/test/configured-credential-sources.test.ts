// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadEnvFileIntoEnvironment } from "../src/config/split-layout.js";
import { observeReaderTaskContextAdmissionV1 } from "../src/execution/reader-task-admission.js";
import { createModelConnection } from "../src/model/provider.js";
import {
  containsConfiguredCredential,
  findConfiguredCredential,
} from "../src/security/configured-credentials.js";
import { CredentialBoundaryError } from "../src/security/credential-isolation.js";
import { redactCredentialMaterial } from "../src/security/credential-material.js";
import { detectCredentialRuleIds } from "../src/security/repository-scanner.js";
import { admitWorkflowRunRequest } from "../src/workflow-execution/runner-admission.js";
import { validModelConfig } from "./helpers.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

// Obviously fake values, assembled from words; deliberately not shaped like a
// credential, so only an exact match can find them (#1807).
const fake = (...words: string[]) => ["fixture", ...words].join("-");

describe("configured credential sources (#1807)", () => {
  const roots = temporaryRoots();

  it("learns the model key a connection uses, even when no environment variable holds it", async () => {
    const key = fake("connection", "key", "orchard", "lamp");
    expect(containsConfiguredCredential(`x ${key}`)).toBe(false);
    await createModelConnection({ ...validModelConfig, apiKey: key });
    expect(findConfiguredCredential(`x ${key}`)).toMatchObject({
      source: "the model key in use",
      form: "value",
    });
  });

  it("sees a credential secrets.env loads in the same synchronous run", async () => {
    const root = await roots.create("docsfab-configured-secrets-env-");
    const value = fake("secrets", "env", "orchard", "lamp");
    const path = join(root, "secrets.env");
    await writeFile(path, `DOCSFAB_FIXTURE_LOADED_TOKEN=${value}\n`);
    const target = process.env;
    try {
      // Read the environment once in this run, before the loader runs.
      expect(containsConfiguredCredential(`x ${value}`)).toBe(false);
      loadEnvFileIntoEnvironment(path, target);
      expect(findConfiguredCredential(`x ${value}`)).toMatchObject({
        source: "environment variable DOCSFAB_FIXTURE_LOADED_TOKEN",
      });
    } finally {
      delete target.DOCSFAB_FIXTURE_LOADED_TOKEN;
    }
  });
});

describe("log redaction of configured credentials (#1807)", () => {
  it("redacts a configured credential that does not look like one, and a credential shape", () => {
    const configured = configureCredential(fake("redaction", "orchard", "lamp"));
    const shaped = `password = "${["Hm2k", "Rt8w", "Q4zx", "L7vp"].join("")}"`;
    const redacted = redactCredentialMaterial(`error: ${configured} rejected; ${shaped}`);
    expect(redacted).not.toContain(configured);
    expect(redacted).not.toContain(configured.slice(4, 20));
    expect(redacted).not.toContain("Hm2kRt8wQ4zxL7vp");
    expect(redacted).toContain("error: ");
  });
});

describe("reader-task admission request text (#1807)", () => {
  const roots = temporaryRoots();

  async function observe(requestText: string) {
    const repository = await roots.create("docsfab-reader-request-text-");
    await initFixtureRepo(repository, { "docs/cli.md": "# CLI\n" });
    return observeReaderTaskContextAdmissionV1({
      repositoryPath: repository,
      observationMode: "workflow-export",
      readerContextInput: {
        schema_version: 1 as const,
        target_audience: "developers",
        reader_job: "run one inspection",
        change_scope: ["docs/cli.md"],
        source_priority: ["public contract", "current docs"],
        required_content: ["command", "verification"],
        excluded_content: ["unrelated internals"],
        unresolved_questions: [],
      },
      requestText,
    });
  }

  it("admits request text that only looks like a credential", async () => {
    const shaped = `Document the setting. password = "${["Zq8v", "N3pL", "5tR7", "wX9y"].join("")}"`;
    expect(detectCredentialRuleIds(shaped)).not.toEqual([]);
    const observed = await observe(shaped);
    const request = observed.sourceBytes.find(
      (entry) => entry.source.uri === "request:instruction",
    );
    expect(Buffer.from(request!.bytes).toString()).toBe(shaped);
  });

  it("refuses request text that holds a configured credential", async () => {
    const configured = configureCredential(fake("request", "text", "orchard", "lamp"));
    await expect(observe(`Document the setting ${configured}.`)).rejects.toThrow(
      "credential-material",
    );
  });
});

describe("retry-context admission credential screen (#1807)", () => {
  it("refuses a configured credential before retry context can be saved", () => {
    const configured = configureCredential(fake("retry", "context", "orchard", "lamp"));
    const request = {
      workflow: "review-documentation",
      repository: { sourcePath: "/repo", requestedRevision: "HEAD", revision: "a".repeat(40) },
      allowWrite: false,
      retryContext: {
        schemaVersion: 1,
        reconstructable: true,
        instructionPresent: false,
        deliveryMode: "read-only",
        allowWrite: false,
        writeGrantExplicit: false,
        releaseGate: false,
        remoteName: configured,
      },
    };

    let failure: unknown;
    try {
      admitWorkflowRunRequest(
        { options: {}, id: () => "run-1", timestamp: () => "2026-10-14T00:00:00.000Z" },
        request as never,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CredentialBoundaryError);
    expect((failure as Error).message).not.toContain(configured);
  });
});
