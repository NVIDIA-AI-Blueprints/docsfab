// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A CREATE plan whose one target already exists as a tracked
 * regular file becomes an UPDATE of that page; several existing targets ask;
 * every other collision stays refused. The conversion lives in the sealed plan
 * binding, so one validator guards it for every reader.
 */
import { describe, expect, it } from "vitest";

import { plannerNeedsInputReasonCode } from "../src/workflow-contracts/planner-diagnostic.js";
import {
  admitCreateTargets,
  bindDocumentationPlanProposal,
  convertCreatePlanPageToUpdate,
  createDocumentationPlanBinding,
  createSourceAwareDocumentationPlanBinding,
  documentationPlanBindingDigest,
  documentationPlanBindingV2Digest,
  documentationPlanWritePaths,
  sealDocumentationPlanBinding,
  validateAdmittedDocumentationPlanBinding,
  type AdmittedDocumentationPlanBinding,
} from "../src/workflow-execution/plan-binding.js";

const EXISTING = "docs/routing/guide.md";
const NEW_PAGE = "docs/routing/new-page.md";
const BASE = "1".repeat(64);
const SOURCE_BINDING = "2".repeat(64);

function createPlan(sourceAware = false): AdmittedDocumentationPlanBinding {
  const input = {
    mode: "create" as const,
    pages: [
      { path: EXISTING, disposition: "create" as const },
      { path: NEW_PAGE, disposition: "create" as const },
    ],
    sourceBindings: [
      { pagePath: EXISTING, sources: ["src/router.py"] },
      { pagePath: NEW_PAGE, sources: ["src/router.py"] },
    ],
  };
  return sourceAware
    ? createSourceAwareDocumentationPlanBinding(input, SOURCE_BINDING)
    : createDocumentationPlanBinding(input);
}

/** Recompute the variant's digest so a tampered body still passes the digest check. */
function resealed(binding: Record<string, unknown>): Record<string, unknown> {
  const { digest: _old, ...body } = binding;
  return { ...body, digest: documentationPlanBindingDigest(body as never) };
}

describe("CREATE target admission rule", () => {
  it.each([
    ["no collision", [], { kind: "create" }],
    [
      "one exact tracked page",
      [{ path: EXISTING, existing: "file" as const, base: { sha256: BASE } }],
      { kind: "convert", path: EXISTING, baseSha256: BASE },
    ],
    [
      "two exact tracked pages",
      [
        { path: NEW_PAGE, existing: "file" as const, base: { sha256: BASE } },
        { path: EXISTING, existing: "file" as const, base: { sha256: BASE } },
      ],
      { kind: "ambiguous", paths: [EXISTING, NEW_PAGE] },
    ],
  ])("%s", (_name, collisions, expected) => {
    expect(admitCreateTargets(collisions)).toEqual(expected);
  });

  it.each([
    [
      "a page the write grant does not let the run modify",
      { path: "docs/other.md", existing: "file" as const, updateRefused: "write-grant" as const },
    ],
    ["a directory", { path: "docs/routing", existing: "directory" as const }],
    ["a path under a file", { path: "README.md/x.md", existing: "parent-file" as const }],
    ["a case variant or non-regular entry", { path: "Docs/Guide.md", existing: "file" as const }],
  ])("refuses %s, even beside a convertible page", (_name, collision) => {
    const convertible = { path: EXISTING, existing: "file" as const, base: { sha256: BASE } };
    expect(admitCreateTargets([convertible, collision])).toEqual({
      kind: "refuse",
      collisions: [convertible, collision],
    });
  });
});

describe("host-only planner stop code", () => {
  it("never lets a model's stated reason claim the host's ambiguous-target stop", () => {
    expect(plannerNeedsInputReasonCode("ambiguous-create-targets")).toBe(
      "model-reported-needs-input",
    );
    expect(plannerNeedsInputReasonCode("ambiguous-scope")).toBe("ambiguous-scope");
  });
});

describe("converted CREATE plan binding", () => {
  it.each([false, true])(
    "seals an UPDATE of the one existing page and keeps every write path (source-aware %s)",
    (sourceAware) => {
      const proposed = createPlan(sourceAware);
      const converted = convertCreatePlanPageToUpdate(
        proposed,
        {
          path: EXISTING,
          baseSha256: BASE,
        },
        "create-target-exists",
      );
      expect(converted.mode).toBe("create");
      expect(converted.schemaVersion).toBe(proposed.schemaVersion);
      expect(converted.pages).toEqual([
        { path: EXISTING, disposition: "update" },
        { path: NEW_PAGE, disposition: "create" },
      ]);
      expect(converted.createConvertedToUpdate).toEqual({
        reason: "create-target-exists",
        path: EXISTING,
        baseSha256: BASE,
      });
      expect(converted.digest).not.toBe(proposed.digest);
      expect(documentationPlanWritePaths(converted)).toEqual(documentationPlanWritePaths(proposed));
      // Every persisted reader re-admits it through the same validator.
      expect(
        validateAdmittedDocumentationPlanBinding(JSON.parse(JSON.stringify(converted)), {
          expectedMode: "create",
        }),
      ).toEqual(converted);
    },
  );

  it.each([false, true])(
    "seals the conversion into the plan digest, so a changed base cannot reuse that digest (source-aware %s)",
    (sourceAware) => {
      const converted = convertCreatePlanPageToUpdate(
        createPlan(sourceAware),
        {
          path: EXISTING,
          baseSha256: BASE,
        },
        "create-target-exists",
      );
      const persisted = JSON.parse(JSON.stringify(converted)) as Record<string, unknown>;
      // The digest input holds the conversion: stripping it alone changes the digest.
      const { digest: _digest, createConvertedToUpdate: _conversion, ...stripped } = converted;
      const digestOf = sourceAware
        ? (body: object) => documentationPlanBindingV2Digest(body as never)
        : (body: object) => documentationPlanBindingDigest(body as never);
      expect(digestOf(stripped)).not.toBe(converted.digest);
      expect(
        digestOf({ ...stripped, createConvertedToUpdate: converted.createConvertedToUpdate }),
      ).toBe(converted.digest);
      // Another base under the same digest is a different plan, refused unsealed.
      const otherBase = {
        ...persisted,
        createConvertedToUpdate: {
          ...converted.createConvertedToUpdate,
          baseSha256: "3".repeat(64),
        },
      };
      expect(() => validateAdmittedDocumentationPlanBinding(otherBase)).toThrow(
        expect.objectContaining({ code: "digest-mismatch" }),
      );
      // The reason is a closed code, refused before the digest is read.
      const otherReason = {
        ...persisted,
        createConvertedToUpdate: { ...converted.createConvertedToUpdate, reason: "operator-asked" },
      };
      expect(() => validateAdmittedDocumentationPlanBinding(otherReason)).toThrow(
        expect.objectContaining({ code: "invalid-shape", location: "$.createConvertedToUpdate" }),
      );
      // A base that is not a SHA-256 digest is refused by shape, even resealed.
      const malformedBase = {
        ...converted,
        createConvertedToUpdate: {
          ...converted.createConvertedToUpdate,
          baseSha256: "f".repeat(63),
        },
      };
      const { digest: _old, ...malformedBody } = malformedBase;
      expect(() =>
        validateAdmittedDocumentationPlanBinding({
          ...JSON.parse(JSON.stringify(malformedBody)),
          digest: digestOf(malformedBody),
        }),
      ).toThrow(
        expect.objectContaining({ code: "invalid-shape", location: "$.createConvertedToUpdate" }),
      );
      // The unchanged persisted form still admits.
      expect(validateAdmittedDocumentationPlanBinding(persisted)).toEqual(converted);
    },
  );

  it("leaves every unconverted digest unchanged", () => {
    const plan = createPlan();
    expect(plan).not.toHaveProperty("createConvertedToUpdate");
    expect(validateAdmittedDocumentationPlanBinding(JSON.parse(JSON.stringify(plan)))).toEqual(
      plan,
    );
  });

  it("refuses an UPDATE page in a CREATE plan that the host did not convert", () => {
    const forged = resealed({
      ...createPlan(),
      pages: [
        { path: EXISTING, disposition: "update" },
        { path: NEW_PAGE, disposition: "create" },
      ],
    });
    expect(() => validateAdmittedDocumentationPlanBinding(forged)).toThrow(
      expect.objectContaining({ code: "invalid-disposition" }),
    );
  });

  it("refuses a conversion a model proposes in a fresh plan", () => {
    const converted = convertCreatePlanPageToUpdate(
      createPlan(),
      {
        path: EXISTING,
        baseSha256: BASE,
      },
      "create-target-exists",
    );
    const { kind: _kind, schemaVersion: _version, digest: _digest, ...semantic } = converted;
    expect(() => sealDocumentationPlanBinding(semantic)).toThrow(
      expect.objectContaining({ code: "invalid-shape" }),
    );
    // The full-proposal form a model may also send reaches the content check itself.
    const { digest: _digest2, ...fullProposal } = converted;
    expect(() => bindDocumentationPlanProposal(fullProposal)).toThrow(
      expect.objectContaining({ code: "invalid-shape", location: "$.createConvertedToUpdate" }),
    );
  });

  it("refuses a conversion that names a page still planned as CREATE, or a second UPDATE page", () => {
    const converted = convertCreatePlanPageToUpdate(
      createPlan(),
      {
        path: EXISTING,
        baseSha256: BASE,
      },
      "create-target-exists",
    );
    const stillCreate = resealed({
      ...converted,
      pages: [
        { path: EXISTING, disposition: "create" },
        { path: NEW_PAGE, disposition: "create" },
      ],
    });
    expect(() => validateAdmittedDocumentationPlanBinding(stillCreate)).toThrow(
      expect.objectContaining({ code: "invalid-disposition" }),
    );
    const secondUpdate = resealed({
      ...converted,
      pages: [
        { path: EXISTING, disposition: "update" },
        { path: NEW_PAGE, disposition: "update" },
      ],
    });
    expect(() => validateAdmittedDocumentationPlanBinding(secondUpdate)).toThrow(
      expect.objectContaining({ code: "invalid-disposition" }),
    );
  });

  it("refuses to convert outside a CREATE plan, twice, or a page the plan does not create", () => {
    const converted = convertCreatePlanPageToUpdate(
      createPlan(),
      {
        path: EXISTING,
        baseSha256: BASE,
      },
      "create-target-exists",
    );
    expect(() =>
      convertCreatePlanPageToUpdate(
        converted,
        { path: NEW_PAGE, baseSha256: BASE },
        "create-target-exists",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-mode" }));
    expect(() =>
      convertCreatePlanPageToUpdate(
        createPlan(),
        { path: "docs/absent.md", baseSha256: BASE },
        "create-target-exists",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-disposition" }));
    const update = createDocumentationPlanBinding({
      mode: "update",
      pages: [{ path: EXISTING, disposition: "update" }],
      sourceBindings: [{ pagePath: EXISTING, sources: ["change evidence"] }],
    });
    expect(() =>
      convertCreatePlanPageToUpdate(
        update,
        { path: EXISTING, baseSha256: BASE },
        "create-target-exists",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-mode" }));
  });
});
