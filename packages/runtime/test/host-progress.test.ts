// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ProgressEvent } from "../src/records/contracts.js";
import {
  HostProgressMapError,
  appendHostedRunProgressEvents,
  createHostedRunProgressAppend,
  mapProgressEventToHostAppend,
  type HostProgressAppendV1,
} from "../src/records/host-progress.js";

const TOKEN = `glpat-${"A".repeat(20)}`;

function runStatus(
  status: "queued" | "running" | "needs-input" | "needs-human-decision" | "succeeded" | "failed",
): ProgressEvent {
  return { sequence: 1, type: "run-status", runId: "run-readiness-1", status };
}

function stepStatus(
  status: Extract<ProgressEvent, { type: "step-status" }>["status"],
  stepId = "search",
): ProgressEvent {
  return { sequence: 2, type: "step-status", runId: "run-readiness-1", stepId, status };
}

describe("mapProgressEventToHostAppend", () => {
  it("maps run-status and step-status with requestKey and runId", () => {
    const running = mapProgressEventToHostAppend("pkt-readiness-1", runStatus("running"));
    expect(running).toEqual({
      requestKey: "pkt-readiness-1",
      type: "run-status",
      status: "running",
      runId: "run-readiness-1",
    });
    expect(Object.keys(running!)).toEqual(["requestKey", "type", "status", "runId"]);
    const stepped = mapProgressEventToHostAppend("pkt-readiness-1", stepStatus("needs-input"));
    expect(stepped).toEqual({
      requestKey: "pkt-readiness-1",
      type: "step-status",
      status: "needs-input",
      runId: "run-readiness-1",
      stepId: "search",
    });
  });

  it("drops text and artifact-reference without copying bodies", () => {
    const text = mapProgressEventToHostAppend("pkt-readiness-1", {
      sequence: 3,
      type: "text",
      runId: "run-readiness-1",
      stepId: "search",
      text: "model prose that must not become observe authority",
    });
    expect(text).toBeNull();
    const artifact = mapProgressEventToHostAppend("pkt-readiness-1", {
      sequence: 4,
      type: "artifact-reference",
      runId: "run-readiness-1",
      stepId: "search",
      status: "referenced",
      artifact: {
        role: "output",
        reference: {
          kind: "ontology",
          schemaVersion: 1,
          digest: "a".repeat(64),
          repositoryRevision: "b".repeat(40),
          repositoryContentDigest: "c".repeat(64),
        },
      },
    });
    expect(artifact).toBeNull();
    expect(JSON.stringify(artifact ?? {})).not.toContain("ontology");
    expect(JSON.stringify(artifact ?? {})).not.toContain("model prose");
  });

  it("drops statuses the host progress API cannot settle", () => {
    expect(mapProgressEventToHostAppend("pkt-1", runStatus("queued"))).toBeNull();
    expect(mapProgressEventToHostAppend("pkt-1", runStatus("succeeded"))).toBeNull();
    expect(mapProgressEventToHostAppend("pkt-1", runStatus("failed"))).toBeNull();
    expect(mapProgressEventToHostAppend("pkt-1", stepStatus("pending"))).toBeNull();
    expect(mapProgressEventToHostAppend("pkt-1", stepStatus("succeeded"))).toBeNull();
  });

  it("rejects credential, grant, URL, path, and patch identifiers", () => {
    expect(() => mapProgressEventToHostAppend(TOKEN, runStatus("running"))).toThrow(
      HostProgressMapError,
    );
    try {
      mapProgressEventToHostAppend(TOKEN, runStatus("running"));
    } catch (error) {
      expect(error).toBeInstanceOf(HostProgressMapError);
      expect((error as HostProgressMapError).code).toBe("credential-material");
    }
    expect(() =>
      mapProgressEventToHostAppend("pkt-1", {
        sequence: 1,
        type: "run-status",
        runId: "--allow-write",
        status: "running",
      }),
    ).toThrow(/write-grant-rejected/);
    expect(() =>
      mapProgressEventToHostAppend("https://example.invalid/run", runStatus("running")),
    ).toThrow(/invalid-value/);
    expect(() =>
      mapProgressEventToHostAppend("/Users/operator/.docsfab/run", runStatus("running")),
    ).toThrow(/invalid-value/);
    expect(() =>
      mapProgressEventToHostAppend("pkt-1", stepStatus("running", "diff --git a/x b/x")),
    ).toThrow(/invalid-value/);
  });

  it("does not import forbidden facades anywhere in the runtime package", async () => {
    const { findPackageImportViolations } = await import("../scripts/check-package-imports.mjs");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    expect(findPackageImportViolations({ root, importers: ["packages/runtime/"] })).toEqual([]);
  });

  it("scopes import scans to all files under the requested importer roots", async () => {
    const { findPackageImportViolations } = await import("../scripts/check-package-imports.mjs");
    const root = mkdtempSync(path.join(tmpdir(), "docsfab-import-scope-"));
    try {
      for (const directory of [
        "packages/runtime/src",
        "packages/runtime/src/nested",
        "packages/quality/src",
        "packages/host/src",
      ]) {
        mkdirSync(path.join(root, directory), { recursive: true });
      }
      writeFileSync(
        path.join(root, "packages/runtime/package.json"),
        JSON.stringify({ name: "@test/runtime" }),
      );
      writeFileSync(
        path.join(root, "packages/quality/package.json"),
        JSON.stringify({ name: "@test/quality" }),
      );
      writeFileSync(
        path.join(root, "packages/host/package.json"),
        JSON.stringify({ name: "@test/host" }),
      );
      writeFileSync(
        path.join(root, "packages/runtime/src/index.js"),
        'import "@test/quality/src/index.js";\n',
      );
      writeFileSync(
        path.join(root, "packages/runtime/src/nested/index.js"),
        'import "@test/quality/src/index.js";\n',
      );
      writeFileSync(path.join(root, "packages/quality/src/index.js"), "export {};\n");
      writeFileSync(
        path.join(root, "packages/host/src/index.js"),
        'import "@test/runtime/src/index.js";\n',
      );

      const allViolations = findPackageImportViolations({ root });
      expect(allViolations.map((violation) => violation.importer).sort()).toEqual([
        "packages/host/src/index.js",
        "packages/runtime/src/index.js",
        "packages/runtime/src/nested/index.js",
      ]);
      const runtimeViolations = findPackageImportViolations({
        root,
        importers: ["packages/runtime/"],
      });
      expect(runtimeViolations.map((violation) => violation.importer).sort()).toEqual([
        "packages/runtime/src/index.js",
        "packages/runtime/src/nested/index.js",
      ]);
      expect(runtimeViolations.every((violation) => violation.prefix === "packages/quality/")).toBe(
        true,
      );
      expect(() => findPackageImportViolations({ root, importers: ["packages/unknown/"] })).toThrow(
        "importers must be a non-empty list of known importer roots",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hosted-run progress append port", () => {
  it("maps ProgressEvent through the injected append and drops text bodies", async () => {
    const appended: HostProgressAppendV1[] = [];
    const emit = createHostedRunProgressAppend("pkt-readiness-1", (dto) => {
      appended.push(dto);
    });
    const running = await emit(runStatus("running"));
    const stepped = await emit(stepStatus("needs-input"));
    const dropped = await emit({
      sequence: 3,
      type: "text",
      runId: "run-readiness-1",
      stepId: "search",
      text: "model prose that must not become observe authority",
    });
    expect(running).toEqual({
      requestKey: "pkt-readiness-1",
      type: "run-status",
      status: "running",
      runId: "run-readiness-1",
    });
    expect(stepped).toEqual({
      requestKey: "pkt-readiness-1",
      type: "step-status",
      status: "needs-input",
      runId: "run-readiness-1",
      stepId: "search",
    });
    expect(dropped).toBeNull();
    expect(appended).toEqual([running, stepped]);
    expect(JSON.stringify(appended)).not.toContain("model prose");
  });

  it("hosted-run fixture maps a stream onto the port without calling append for dropped events", async () => {
    const appended: HostProgressAppendV1[] = [];
    const dtos = await appendHostedRunProgressEvents(
      "pkt-readiness-1",
      [
        runStatus("running"),
        stepStatus("running"),
        {
          sequence: 3,
          type: "artifact-reference",
          runId: "run-readiness-1",
          stepId: "search",
          status: "referenced",
          artifact: {
            role: "output",
            reference: {
              kind: "ontology",
              schemaVersion: 1,
              digest: "a".repeat(64),
              repositoryRevision: "b".repeat(40),
              repositoryContentDigest: "c".repeat(64),
            },
          },
        },
        runStatus("queued"),
        runStatus("needs-human-decision"),
      ],
      (dto) => {
        appended.push(dto);
      },
    );
    expect(dtos).toEqual([
      {
        requestKey: "pkt-readiness-1",
        type: "run-status",
        status: "running",
        runId: "run-readiness-1",
      },
      {
        requestKey: "pkt-readiness-1",
        type: "step-status",
        status: "running",
        runId: "run-readiness-1",
        stepId: "search",
      },
      {
        requestKey: "pkt-readiness-1",
        type: "run-status",
        status: "needs-human-decision",
        runId: "run-readiness-1",
      },
    ]);
    expect(appended).toEqual(dtos);
    expect(JSON.stringify(dtos)).not.toContain("ontology");
  });
});
