// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  KnowledgeSnapshotImportError,
  createKnowledgeAcceptedSnapshot,
  decodeFoundationCanon,
  decodeKnowledgeAcceptedSnapshot,
  decodeKnowledgeResumeReceipt,
  importFoundationCanonFromKnowledgeSnapshot,
  type KnowledgeAcceptedSnapshotBodyV1,
} from "../src/canon/index.js";
import { configureCredential } from "./helpers/configured-credential.js";

function acceptedBody(
  overrides: Partial<KnowledgeAcceptedSnapshotBodyV1> = {},
): KnowledgeAcceptedSnapshotBodyV1 {
  return {
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    streamVersion: 7,
    status: "approved",
    claims: [
      {
        id: "CL-001",
        kind: "intent",
        scope: "Example Product",
        statement:
          "The knowledge-gathering workflow establishes a shared model before documentation generation.",
        modelState: "canonical",
        evidenceIds: ["SRC-001"],
      },
    ],
    sources: [{ id: "SRC-001", locator: "design" }],
    conflicts: [],
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(KnowledgeSnapshotImportError);
  try {
    action();
  } catch (error) {
    expect((error as KnowledgeSnapshotImportError).code).toBe(code);
  }
}

describe("knowledge snapshot import", () => {
  it("decodes an accepted snapshot into FoundationCanonV1 with canonSha256", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(acceptedBody());
    const fixture = JSON.parse(JSON.stringify(snapshot)) as unknown;
    const decoded = decodeKnowledgeAcceptedSnapshot(fixture);
    expect(decoded).toEqual(snapshot);
    expect(decoded.kind).toBe("knowledge-accepted-snapshot");
    expect(decoded.status).toBe("approved");

    const canon = importFoundationCanonFromKnowledgeSnapshot(fixture);
    expect(canon.state).toBe("accepted");
    expect(canon.kind).toBe("docsfab-foundation-canon");
    expect(canon.canonSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(canon.repository.contentDigestSha256).toBe(snapshot.snapshotSha256);
    expect(canon.claims[0]?.statementSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(canon.evidence[0]?.id).toBe("SRC-001");
    expect(decodeFoundationCanon(JSON.parse(JSON.stringify(canon)))).toEqual(canon);
    expect(importFoundationCanonFromKnowledgeSnapshot(fixture).canonSha256).toBe(canon.canonSha256);
  });

  it("imports a knowledge-exported JSON fixture without importing knowledge modules", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/runtime-evaluation/fixtures/knowledge-accepted-snapshot.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;
    const decoded = decodeKnowledgeAcceptedSnapshot(fixture);
    expect(decoded.kind).toBe("knowledge-accepted-snapshot");
    expect(decoded.status).toBe("approved");
    const canon = importFoundationCanonFromKnowledgeSnapshot(fixture);
    expect(canon.state).toBe("accepted");
    expect(canon.kind).toBe("docsfab-foundation-canon");
    expect(canon.canonSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(canon.repository.contentDigestSha256).toBe(decoded.snapshotSha256);
  });

  it("imports a canonical-status snapshot the same way as approved", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(acceptedBody({ status: "canonical" }));
    const canon = importFoundationCanonFromKnowledgeSnapshot(snapshot);
    expect(canon.state).toBe("accepted");
    expect(canon.kind).toBe("docsfab-foundation-canon");
  });

  it("rejects a sealed snapshot whose status is not approved or canonical", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(acceptedBody({ status: "candidate" }));
    expect(decodeKnowledgeAcceptedSnapshot(snapshot).status).toBe("candidate");
    expectCode(() => importFoundationCanonFromKnowledgeSnapshot(snapshot), "invalid-value");
  });

  it("host-accepts a candidate snapshot into Foundation Canon without rewriting status", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(acceptedBody({ status: "candidate" }));
    expect(snapshot.status).toBe("candidate");
    const canon = importFoundationCanonFromKnowledgeSnapshot(snapshot, {
      authorityId: "operator-test",
    });
    expect(canon.state).toBe("accepted");
    expect(canon.kind).toBe("docsfab-foundation-canon");
    expect(canon.authority?.authorityId).toBe("operator:operator-test:knowledge:PRJ-001:MODEL-001");
    expect(canon.repository.contentDigestSha256).toBe(snapshot.snapshotSha256);
    expect(snapshot.status).toBe("candidate");
    expect(
      importFoundationCanonFromKnowledgeSnapshot(snapshot, { authorityId: "operator-test" })
        .canonSha256,
    ).toBe(canon.canonSha256);
    expect(
      importFoundationCanonFromKnowledgeSnapshot(snapshot, { authorityId: "other-operator" })
        .canonSha256,
    ).not.toBe(canon.canonSha256);
  });

  it("rejects host-accept on an already approved snapshot", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(acceptedBody());
    expectCode(
      () => importFoundationCanonFromKnowledgeSnapshot(snapshot, { authorityId: "operator-test" }),
      "invalid-value",
    );
  });

  it("rejects digest mismatch, wrong kind, wrong schemaVersion, missing fields, and credentials", () => {
    configureCredential(["glpat", "abcdefghijklmnopqrstuvwxyz0123"].join("-"));
    const snapshot = createKnowledgeAcceptedSnapshot(acceptedBody());
    expectCode(
      () =>
        decodeKnowledgeAcceptedSnapshot({
          ...snapshot,
          snapshotSha256: "f".repeat(64),
        }),
      "digest-mismatch",
    );
    expectCode(
      () => decodeKnowledgeAcceptedSnapshot({ ...snapshot, kind: "docsfab-foundation-canon" }),
      "migration-required",
    );
    expectCode(
      () => decodeKnowledgeAcceptedSnapshot({ ...snapshot, schemaVersion: 2 }),
      "migration-required",
    );
    const { claims: _claims, ...missing } = snapshot;
    expectCode(() => decodeKnowledgeAcceptedSnapshot(missing), "invalid-shape");
    expectCode(
      () =>
        createKnowledgeAcceptedSnapshot(
          acceptedBody({
            claims: [
              {
                id: "CL-001",
                kind: "intent",
                scope: "Example Product",
                statement: "glpat-abcdefghijklmnopqrstuvwxyz0123",
                modelState: "canonical",
                evidenceIds: ["SRC-001"],
              },
            ],
          }),
        ),
      "credential-material",
    );
    expectCode(
      () =>
        createKnowledgeAcceptedSnapshot(
          acceptedBody({
            sources: [{ id: "SRC-001", locator: "design", title: "secret body" } as never],
          }),
        ),
      "invalid-shape",
    );
  });

  it("normalizes closed conflict classifications and strict advisory receipts", () => {
    const snapshot = createKnowledgeAcceptedSnapshot(
      acceptedBody({
        claims: [
          acceptedBody().claims[0]!,
          {
            ...acceptedBody().claims[0]!,
            id: "CL-002",
            statement: "The legacy command prints a different label.",
            modelState: "disputed",
          },
        ],
        conflicts: [
          {
            id: "CF-001",
            claimIds: ["CL-002", "CL-001"],
            classification: {
              impact: "load-bearing",
              impactBasisSha256: "b".repeat(64),
              blockingDocumentationPaths: ["docs/about/product.md"],
              resolutionOwner: "product-owner",
              authorityKind: "product-decision-owner",
            },
          },
        ],
      }),
    );
    expect(snapshot.conflicts[0]).toMatchObject({
      claimIds: ["CL-001", "CL-002"],
      classification: {
        blockingDocumentationPaths: ["docs/about/product.md"],
      },
    });
    expect(decodeKnowledgeAcceptedSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);

    const receipt = decodeKnowledgeResumeReceipt({
      schemaVersion: 1,
      kind: "docsfab-knowledge-resume-receipt",
      snapshotSha256: snapshot.snapshotSha256,
      selectedTargetPath: "docs/reference/cli.mdx",
      advisoryConflicts: [
        {
          conflictId: "CF-001",
          claimIds: ["CL-002", "CL-001"],
          ...snapshot.conflicts[0]!.classification!,
        },
      ],
    });
    expect(receipt.advisoryConflicts[0]?.claimIds).toEqual(["CL-001", "CL-002"]);

    expectCode(
      () =>
        decodeKnowledgeResumeReceipt({
          ...receipt,
          advisoryConflicts: [
            {
              ...receipt.advisoryConflicts[0],
              blockingDocumentationPaths: [receipt.selectedTargetPath],
            },
          ],
        }),
      "invalid-value",
    );
    expectCode(
      () =>
        createKnowledgeAcceptedSnapshot(
          acceptedBody({
            claims: [acceptedBody().claims[0]!, { ...acceptedBody().claims[0]!, id: "CL-002" }],
            conflicts: [
              {
                id: "CF-001",
                claimIds: ["CL-001", "CL-002"],
                classification: {
                  impact: "load-bearing",
                  impactBasisSha256: "b".repeat(64),
                  blockingDocumentationPaths: ["../docs/about.md"],
                  resolutionOwner: "product-owner",
                  authorityKind: "product-decision-owner",
                },
              },
            ],
          }),
        ),
      "unsafe-path",
    );
  });
});
