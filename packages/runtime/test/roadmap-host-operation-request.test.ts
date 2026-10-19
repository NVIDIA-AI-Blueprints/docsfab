// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

import {
  createRoadmapHostOperationRequest,
  RoadmapHostOperationRequestError,
  validateRoadmapHostOperationRequest,
} from "../src/roadmap/index.js";
import {
  ROADMAP_SKILL_PACK_CONTRACTS,
  type RoadmapSkillPackId,
} from "../src/skills/roadmap-pack.js";

const SHA = "74609ef309df19b62fd8a16de8aac878181cdd5169807a7507cc2b7e5144d9d3";
const REVISION = "b".repeat(40);

function common() {
  return {
    pack: { id: "release-docs-epic", contractSha256: SHA },
    repository: { revision: REVISION, contentSha256: "c".repeat(64) },
  } as const;
}

function commonFor(id: RoadmapSkillPackId) {
  return {
    pack: { id, contractSha256: ROADMAP_SKILL_PACK_CONTRACTS[id].contractSha256 },
    repository: { revision: REVISION, contentSha256: "c".repeat(64) },
  } as const;
}

describe("roadmap host-operation requests", () => {
  afterEach(() => {
    clearPlantedCredential();
  });

  it("creates deterministic content-bound read requests", () => {
    const input = {
      ...common(),
      operation: "observe-repository-history" as const,
      confirmationPolicy: "not-required" as const,
      boundaryDigest: "d".repeat(64),
    };
    const first = createRoadmapHostOperationRequest(input);
    const second = createRoadmapHostOperationRequest(structuredClone(input));

    expect(first).toEqual(second);
    expect(first.requestId).toBe(`roadmap-host:${first.deduplicationKey}`);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each([
    {
      packId: "release-docs-epic" as const,
      operation: "apply-roadmap-mutation" as const,
      ledgerDigest: "d".repeat(64),
      planDigest: "e".repeat(64),
      authorizationDigest: "f".repeat(64),
    },
    {
      packId: "doc-fix-issues" as const,
      operation: "deliver-roadmap-child" as const,
      ledgerDigest: "d".repeat(64),
      findingFingerprint: "e".repeat(64),
      selectionAuthorizationDigest: "f".repeat(64),
      deliveryPlanDigest: "0".repeat(64),
    },
    {
      packId: "doc-pr-auto-sync" as const,
      operation: "update-merge-request-description" as const,
      projectIdentityDigest: "d".repeat(64),
      mergeRequestIid: 44,
      observedUpdatedAt: "2026-08-04T12:00:00.000Z",
      descriptionDigest: "e".repeat(64),
      authorizationDigest: "f".repeat(64),
    },
  ])("requires explicit authorization for $operation", ({ packId, ...operation }) => {
    const request = createRoadmapHostOperationRequest({
      ...commonFor(packId),
      ...operation,
      confirmationPolicy: "explicit-authorization-required",
    });
    expect(request.confirmationPolicy).toBe("explicit-authorization-required");
  });

  it("enforces the closed pack-to-operation policy exhaustively", () => {
    const allowed = {
      "release-docs-epic": new Set([
        "observe-repository-history",
        "observe-tracker",
        "apply-roadmap-mutation",
      ]),
      "doc-fix-issues": new Set(["deliver-roadmap-child"]),
      "doc-session-insights": new Set(["observe-tracker", "apply-roadmap-mutation"]),
      "doc-pr-auto-sync": new Set(["update-merge-request-description"]),
    } as const;
    const operationInput = (operation: string): Record<string, unknown> =>
      operation === "observe-repository-history"
        ? { boundaryDigest: "d".repeat(64) }
        : operation === "observe-tracker"
          ? { projectIdentityDigest: "d".repeat(64), queryDigest: "e".repeat(64) }
          : operation === "apply-roadmap-mutation"
            ? {
                ledgerDigest: "d".repeat(64),
                planDigest: "e".repeat(64),
                authorizationDigest: "f".repeat(64),
              }
            : operation === "deliver-roadmap-child"
              ? {
                  ledgerDigest: "d".repeat(64),
                  findingFingerprint: "e".repeat(64),
                  selectionAuthorizationDigest: "f".repeat(64),
                  deliveryPlanDigest: "0".repeat(64),
                }
              : {
                  projectIdentityDigest: "d".repeat(64),
                  mergeRequestIid: 44,
                  observedUpdatedAt: "2026-08-04T12:00:00.000Z",
                  descriptionDigest: "e".repeat(64),
                  authorizationDigest: "f".repeat(64),
                };
    for (const packId of Object.keys(allowed) as RoadmapSkillPackId[]) {
      for (const operation of [
        "observe-repository-history",
        "observe-tracker",
        "apply-roadmap-mutation",
        "deliver-roadmap-child",
        "update-merge-request-description",
      ] as const) {
        const candidate = {
          ...commonFor(packId),
          operation,
          confirmationPolicy: operation.startsWith("observe-")
            ? ("not-required" as const)
            : ("explicit-authorization-required" as const),
          ...operationInput(operation),
        };
        if (allowed[packId].has(operation as never)) {
          expect(() => createRoadmapHostOperationRequest(candidate as never)).not.toThrow();
        } else {
          expect(() => createRoadmapHostOperationRequest(candidate as never)).toThrowError(
            expect.objectContaining({ code: "invalid-value", field: "$.operation" }),
          );
        }
      }
    }
  });

  it("rejects --auto-style confirmation bypasses", () => {
    const request = createRoadmapHostOperationRequest({
      ...common(),
      operation: "apply-roadmap-mutation",
      confirmationPolicy: "explicit-authorization-required",
      ledgerDigest: "d".repeat(64),
      planDigest: "e".repeat(64),
      authorizationDigest: "f".repeat(64),
    });
    const bypass = { ...request, confirmationPolicy: "not-required" };
    expect(() => validateRoadmapHostOperationRequest(bypass)).toThrowError(
      expect.objectContaining({ code: "confirmation-bypass" }),
    );
  });

  it.each(["command", "args", "env", "credentials"])(
    "rejects an untyped %s field without echoing its value",
    (field) => {
      const request = createRoadmapHostOperationRequest({
        ...common(),
        operation: "observe-tracker",
        confirmationPolicy: "not-required",
        projectIdentityDigest: "d".repeat(64),
        queryDigest: "e".repeat(64),
      });
      const sentinel = "HOST_SECRET_SENTINEL";
      let message = "";
      try {
        validateRoadmapHostOperationRequest({ ...request, [field]: sentinel });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("invalid-shape");
      expect(message).not.toContain(sentinel);
    },
  );

  // `validateRoadmapHostOperationRequest` runs the credential screen
  // (`detectCredentialRuleIdsInValue`) before the unknown-key shape check, so a
  // value that looks like credential material cannot reach a shape error path.
  // An own key `token` with a 12+ character value is credential material, so
  // this refuses with `invalid-value` at `$`, not `invalid-shape`. `token` is
  // not an allowed key of any roadmap host-operation request, so no legitimate
  // request changes outcome, and the value is still not echoed. Both halves
  // are asserted so a reorder of the two checks is caught here.
  it("records an untyped token field at the credential screen, then refuses it at the shape check, without echoing its value", () => {
    const request = createRoadmapHostOperationRequest({
      ...common(),
      operation: "observe-tracker",
      confirmationPolicy: "not-required",
      projectIdentityDigest: "d".repeat(64),
      queryDigest: "e".repeat(64),
    });
    const sentinel = "HOST_SECRET_SENTINEL";
    let message = "";
    const { findings } = collectCredentialFindings(() => {
      try {
        validateRoadmapHostOperationRequest({ ...request, token: sentinel });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    });
    expect(findings.map((finding) => finding.location)).toEqual(["roadmap-host-operation"]);
    expect(JSON.stringify(findings)).not.toContain(sentinel);
    expect(message).toContain("invalid-shape");
    expect(message).not.toContain(sentinel);
  });

  it("refuses DocsFab's own configured credential at the credential screen, before the shape check, without echoing it", () => {
    const request = createRoadmapHostOperationRequest({
      ...common(),
      operation: "observe-tracker",
      confirmationPolicy: "not-required",
      projectIdentityDigest: "d".repeat(64),
      queryDigest: "e".repeat(64),
    });
    const planted = plantConfiguredCredential();
    let message = "";
    try {
      validateRoadmapHostOperationRequest({ ...request, label: planted });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("(invalid-value) at $.");
    expect(message).not.toContain("invalid-shape");
    expect(message).not.toContain(planted);
  });

  // Adjacent condition for the branch above: an untyped field whose name is
  // one step outside the credential-key class, and a `token` field whose value
  // is one character below the 12-character floor, must still be refused by
  // the shape check with the value unechoed. Otherwise the expectation above
  // could be satisfied by a screen that refuses every unknown field as
  // `invalid-value`.
  it.each([
    ["tokens", "HOST_SECRET_SENTINEL"],
    ["token-count", "HOST_SECRET_SENTINEL"],
    ["token", "SENTINEL_11"],
  ])(
    "rejects an untyped %s field at the shape check, not the credential screen",
    (field, value) => {
      const request = createRoadmapHostOperationRequest({
        ...common(),
        operation: "observe-tracker",
        confirmationPolicy: "not-required",
        projectIdentityDigest: "d".repeat(64),
        queryDigest: "e".repeat(64),
      });
      let message = "";
      try {
        validateRoadmapHostOperationRequest({ ...request, [field]: value });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("invalid-shape");
      expect(message).not.toContain(value);
    },
  );

  it("rejects request and evidence drift", () => {
    const request = createRoadmapHostOperationRequest({
      ...common(),
      operation: "observe-tracker",
      confirmationPolicy: "not-required",
      projectIdentityDigest: "d".repeat(64),
      queryDigest: "e".repeat(64),
    });
    expect(() =>
      validateRoadmapHostOperationRequest({
        ...request,
        queryDigest: "f".repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: "digest-mismatch" }));
  });

  it.each(["doc-audit", "tpl-design-ia", "release-docs-epic-extra"])(
    "rejects non-roadmap pack identity %s",
    (id) => {
      const request = createRoadmapHostOperationRequest({
        ...common(),
        operation: "observe-tracker",
        confirmationPolicy: "not-required",
        projectIdentityDigest: "d".repeat(64),
        queryDigest: "e".repeat(64),
      });
      expect(() =>
        validateRoadmapHostOperationRequest({
          ...request,
          pack: { ...request.pack, id },
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
    },
  );

  it("rejects a syntactically valid but unreviewed pack contract hash", () => {
    expect(() =>
      createRoadmapHostOperationRequest({
        ...common(),
        pack: { ...common().pack, contractSha256: "f".repeat(64) },
        operation: "observe-tracker",
        confirmationPolicy: "not-required",
        projectIdentityDigest: "d".repeat(64),
        queryDigest: "e".repeat(64),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid-value",
        field: "$.pack.contractSha256",
      }),
    );
  });

  it.each(["command", "args", "env", "tool"])("rejects nested pack %s escape fields", (field) => {
    const request = createRoadmapHostOperationRequest({
      ...common(),
      operation: "observe-tracker",
      confirmationPolicy: "not-required",
      projectIdentityDigest: "d".repeat(64),
      queryDigest: "e".repeat(64),
    });
    expect(() =>
      validateRoadmapHostOperationRequest({
        ...request,
        pack: { ...request.pack, [field]: "git push" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-shape" }));
  });

  it.each([
    `glpat-${"s".repeat(24)}`,
    `AIza${"a".repeat(35)}`,
    "AKIA1234567890ABCDEF",
    "-----BEGIN PRIVATE KEY-----",
  ])("credential-scans pack identifiers without echoing %s", (sentinel) => {
    const request = createRoadmapHostOperationRequest({
      ...common(),
      operation: "observe-tracker",
      confirmationPolicy: "not-required",
      projectIdentityDigest: "d".repeat(64),
      queryDigest: "e".repeat(64),
    });
    let message = "";
    try {
      validateRoadmapHostOperationRequest({
        ...request,
        pack: { ...request.pack, id: sentinel },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("invalid-value");
    expect(message).not.toContain(sentinel);
  });
});
