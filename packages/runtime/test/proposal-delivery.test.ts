// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createDeliveryRequest,
  DeliveryAuthorityError,
  type DeliveryRequestInputV1,
  type DeliveryTargetBindingV1,
} from "../src/delivery/delivery-authority.js";

const HASH = "b".repeat(64);
const BASE = "c".repeat(40);
const HEAD = "d".repeat(40);

function binding(): DeliveryTargetBindingV1 {
  return {
    host: "gitlab.example.com",
    projectId: 437040,
    repository: "tech-docs/agents/example",
    baseRevision: BASE,
    headRevision: HEAD,
    patchDigestSha256: HASH,
    allowedPaths: ["docs"],
    protection: {
      defaultBranch: "main",
      sourceBranch: "docsfab/topic",
      sourceProtected: false,
      targetProtected: true,
      sourceIsDefault: false,
    },
    grant: { version: 1, tier: "contribute", updateExistingMrEnabled: false },
  };
}

function input(overrides: Partial<DeliveryRequestInputV1> = {}): DeliveryRequestInputV1 {
  return {
    trigger: "api",
    intent: "create-draft-mr",
    authorityBasis: "standing-repo-grant",
    controller: "one-shot",
    logicalRequestId: "req-229",
    mergeRequestIid: null,
    binding: binding(),
    ...overrides,
  };
}

describe("typed proposal delivery submit", () => {
  it("seals a host-bound request without credentials or SCM handles", () => {
    const request = createDeliveryRequest(input());
    expect(request.kind).toBe("docsfab-delivery-request");
    expect(request.intent).toBe("create-draft-mr");
    expect(JSON.stringify(request)).not.toMatch(/glpat-|token|lease/u);
  });

  it("fails closed on extra credential or executable fields before any host apply", () => {
    expect(() =>
      createDeliveryRequest({ ...input(), token: "glpat-" + "A".repeat(20) } as never),
    ).toThrow(DeliveryAuthorityError);
    expect(() =>
      createDeliveryRequest({ ...input(), argv: ["glab", "mr", "create"] } as never),
    ).toThrow(DeliveryAuthorityError);
  });
});
