// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AUTHORITY_BASES,
  DELIVERY_CONTROLLERS,
  DELIVERY_INTENTS,
  DELIVERY_TRIGGERS,
  DeliveryAuthorityError,
  DeliveryKeyLedger,
  EXCLUDED_DELIVERY_POWERS,
  SUPPORTED_DELIVERY_COMBINATIONS,
  assertExcludedDeliveryPowerDenied,
  createDeliveryRequest,
  decodeDeliveryRequest,
  deliveryCombinationStatus,
  deliveryKeyForRequest,
  type DeliveryRequestInputV1,
  type DeliveryTargetBindingV1,
} from "../src/delivery/delivery-authority.js";
import {
  GRANT_TIER_OPERATIONS,
  createCredentialBrokerIdentityClass,
  createRepositoryGrant,
  decodeCredentialBrokerIdentityClass,
  decodeEffectiveAuthority,
  intersectEffectiveAuthority,
  mintFreshDeliveryRevalidation,
  scmStateSha256,
  type DeliveryScmStateV1,
  type RepositoryGrantV1,
} from "../src/delivery/effective-authority.js";
import {
  decodeHostJobEnvelopeProjection,
  projectV1HostJobEnvelopeRecord,
} from "../src/autonomy/host-job-envelope-projection.js";
import {
  mintHostJobEnvelope,
  projectHostMintedEnvelope,
  requireHostMintedEnvelope,
} from "../src/autonomy/managed-publish-host.js";

const HASH = "a".repeat(64);
const PATCH = "b".repeat(64);
const BASE = "c".repeat(40);
const HEAD = "d".repeat(40);
const CLAIMED_AT = "2026-08-21T12:00:00.000Z";

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DeliveryAuthorityError);
    expect((error as DeliveryAuthorityError).code).toBe(code);
  }
}

function binding(overrides: Partial<DeliveryTargetBindingV1> = {}): DeliveryTargetBindingV1 {
  return {
    host: "gitlab.example.com",
    projectId: 437040,
    repository: "tech-docs/agents/example",
    baseRevision: BASE,
    headRevision: HEAD,
    patchDigestSha256: PATCH,
    allowedPaths: ["docs"],
    protection: {
      defaultBranch: "main",
      sourceBranch: "docsfab/topic",
      sourceProtected: false,
      targetProtected: true,
      sourceIsDefault: false,
      ...overrides.protection,
    },
    grant: {
      version: 1,
      tier: "contribute",
      updateExistingMrEnabled: false,
      ...overrides.grant,
    },
    ...omitNested(overrides),
  };
}

function omitNested(
  overrides: Partial<DeliveryTargetBindingV1>,
): Omit<Partial<DeliveryTargetBindingV1>, "protection" | "grant"> {
  const { protection: _protection, grant: _grant, ...rest } = overrides;
  return rest;
}

function requestInput(overrides: Partial<DeliveryRequestInputV1> = {}): DeliveryRequestInputV1 {
  return {
    trigger: "interactive",
    intent: "create-draft-mr",
    authorityBasis: "standing-repo-grant",
    controller: "one-shot",
    logicalRequestId: "request:draft-1",
    mergeRequestIid: null,
    binding: binding(),
    ...overrides,
  };
}

function artifactInput(): DeliveryRequestInputV1 {
  return requestInput({
    intent: "artifact-only",
    authorityBasis: "none",
    logicalRequestId: "request:artifact-1",
    binding: binding({ grant: { version: 1, tier: "discover", updateExistingMrEnabled: false } }),
  });
}

function commentInput(): DeliveryRequestInputV1 {
  return requestInput({
    intent: "comment-existing-mr",
    authorityBasis: "standing-repo-grant",
    logicalRequestId: "request:comment-1",
    mergeRequestIid: 88,
    binding: binding({ grant: { version: 1, tier: "review", updateExistingMrEnabled: false } }),
  });
}

function contributeGrant(): RepositoryGrantV1 {
  return createRepositoryGrant({
    grantVersion: 1,
    host: "gitlab.example.com",
    projectId: 437040,
    tier: "contribute",
    status: "active",
    updateExistingMr: {
      enabled: false,
      ownershipPolicy: "none",
      forkPolicy: "none",
      headPolicy: "none",
    },
  });
}

function reviewGrant(): RepositoryGrantV1 {
  return createRepositoryGrant({
    grantVersion: 1,
    host: "gitlab.example.com",
    projectId: 437040,
    tier: "review",
    status: "active",
    updateExistingMr: {
      enabled: false,
      ownershipPolicy: "none",
      forkPolicy: "none",
      headPolicy: "none",
    },
  });
}

function scmState(overrides: Partial<DeliveryScmStateV1> = {}): DeliveryScmStateV1 {
  return {
    grantStatus: "active",
    currentHeadRevision: HEAD,
    sourceBranchProtected: false,
    sourceBranchIsDefault: false,
    ...overrides,
  };
}

function openPolicy() {
  return {
    allowedIntents: [...DELIVERY_INTENTS],
    allowedControllers: [...DELIVERY_CONTROLLERS],
    allowedAuthorityBases: [...AUTHORITY_BASES],
  };
}

function hostService(namedOperations = [...GRANT_TIER_OPERATIONS.contribute]) {
  return {
    publisher: "host-owned" as const,
    broker: createCredentialBrokerIdentityClass(),
    namedOperations,
  };
}

describe("delivery combination matrix", () => {
  it("supports the six initial rows and reserves update-existing-mr", () => {
    expect(SUPPORTED_DELIVERY_COMBINATIONS).toHaveLength(6);
    expect(DELIVERY_TRIGGERS).toEqual(["interactive", "api", "webhook"]);
    expect(deliveryCombinationStatus("artifact-only", "none", "one-shot")).toBe("supported");
    expect(deliveryCombinationStatus("create-draft-mr", "standing-repo-grant", "one-shot")).toBe(
      "supported",
    );
    expect(
      deliveryCombinationStatus("comment-existing-mr", "standing-repo-grant", "bounded-reconcile"),
    ).toBe("supported");
    expect(deliveryCombinationStatus("update-existing-mr", "standing-repo-grant", "one-shot")).toBe(
      "reserved",
    );
    expect(deliveryCombinationStatus("create-draft-mr", "none", "one-shot")).toBe("denied");
  });

  it("enumerates every axis tuple and fails closed outside the supported set", () => {
    let supported = 0;
    let reserved = 0;
    let denied = 0;
    for (const intent of DELIVERY_INTENTS) {
      for (const authority of AUTHORITY_BASES) {
        for (const controller of DELIVERY_CONTROLLERS) {
          const status = deliveryCombinationStatus(intent, authority, controller);
          if (status === "supported") supported += 1;
          else if (status === "reserved") reserved += 1;
          else denied += 1;
        }
      }
    }
    expect(supported).toBe(6);
    expect(reserved).toBe(DELIVERY_CONTROLLERS.length * AUTHORITY_BASES.length);
    expect(supported + reserved + denied).toBe(
      DELIVERY_INTENTS.length * AUTHORITY_BASES.length * DELIVERY_CONTROLLERS.length,
    );
  });

  it("denies excluded publication powers", () => {
    for (const power of EXCLUDED_DELIVERY_POWERS) {
      expectCode(() => assertExcludedDeliveryPowerDenied(power), "excluded-power");
    }
  });
});

describe("typed delivery request and target binding", () => {
  it("seals a create-draft-mr request bound to host, project, revisions, patch, paths, and grant", () => {
    const request = createDeliveryRequest(requestInput());
    expect(request.kind).toBe("docsfab-delivery-request");
    expect(request.binding.projectId).toBe(437040);
    expect(request.binding.grant.tier).toBe("contribute");
    expect(decodeDeliveryRequest(structuredClone(request))).toEqual(request);
    expect(createDeliveryRequest(requestInput({ trigger: "webhook" })).trigger).toBe("webhook");
  });

  it("rejects an inferred nearby combination instead of widening it", () => {
    expectCode(
      () => createDeliveryRequest(requestInput({ authorityBasis: "none" })),
      "unsupported-combination",
    );
    expectCode(
      () =>
        createDeliveryRequest(
          requestInput({
            intent: "update-existing-mr",
            authorityBasis: "standing-repo-grant",
            mergeRequestIid: 12,
          }),
        ),
      "reserved-combination",
    );
  });

  it("rejects protected or default source branches for create-draft-mr", () => {
    expectCode(
      () =>
        createDeliveryRequest(
          requestInput({
            binding: binding({
              protection: {
                defaultBranch: "main",
                sourceBranch: "main",
                sourceProtected: false,
                targetProtected: true,
                sourceIsDefault: true,
              },
            }),
          }),
        ),
      "excluded-power",
    );
  });

  it("requires an MR iid only for comment-existing-mr", () => {
    expectCode(() => createDeliveryRequest(requestInput({ mergeRequestIid: 9 })), "invalid-value");
    expectCode(
      () => createDeliveryRequest({ ...commentInput(), mergeRequestIid: null }),
      "invalid-value",
    );
  });
});

describe("durable delivery-key ledger", () => {
  it("replays the same delivery key without duplicating the claim", () => {
    const request = createDeliveryRequest(requestInput());
    const ledger = new DeliveryKeyLedger();
    const first = ledger.claim(request, CLAIMED_AT);
    const second = ledger.claim(request, "2026-08-21T12:01:00.000Z");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.entrySha256).toBe(first.entry.entrySha256);
    expect(second.entry.claimedAt).toBe(CLAIMED_AT);
  });

  it("round-trips exported entries and stays replay-safe", () => {
    const request = createDeliveryRequest(requestInput());
    const ledger = new DeliveryKeyLedger();
    ledger.claim(request, CLAIMED_AT);
    const restored = DeliveryKeyLedger.import(structuredClone(ledger.exportEntries()));
    const replay = restored.claim(request, "2026-08-21T13:00:00.000Z");
    expect(replay.created).toBe(false);
    expect(replay.entry.requestSha256).toBe(request.requestSha256);
  });

  it("collides comment retries on project, MR, logical request, and intent", () => {
    const first = createDeliveryRequest(commentInput());
    const drifted = createDeliveryRequest({
      ...commentInput(),
      binding: binding({
        grant: { version: 1, tier: "review", updateExistingMrEnabled: false },
        headRevision: "e".repeat(40),
      }),
    });
    expect(deliveryKeyForRequest(first).keySha256).toBe(deliveryKeyForRequest(drifted).keySha256);
    const ledger = new DeliveryKeyLedger();
    ledger.claim(first, CLAIMED_AT);
    expectCode(() => ledger.claim(drifted, CLAIMED_AT), "delivery-conflict");
  });

  it("rejects a forged ledger entry that copies shape without a valid digest", () => {
    const request = createDeliveryRequest(requestInput());
    const ledger = new DeliveryKeyLedger();
    const { entry } = ledger.claim(request, CLAIMED_AT);
    const forged = { ...structuredClone(entry), intent: "artifact-only" };
    expectCode(() => DeliveryKeyLedger.import([forged]), "digest-mismatch");
  });
});

describe("effective authority intersection", () => {
  it("intersects requester, grant, workflow policy, service capability, and SCM state", () => {
    const request = createDeliveryRequest(requestInput());
    const grant = contributeGrant();
    const scm = scmState();
    const key = deliveryKeyForRequest(request);
    const authority = intersectEffectiveAuthority({
      request,
      requester: { entitlement: "operator" },
      grant,
      workflowPolicy: openPolicy(),
      serviceCapability: hostService(),
      scmState: scm,
      revalidation: mintFreshDeliveryRevalidation({
        deliveryKeySha256: key.keySha256,
        scmStateSha256: scmStateSha256(scm),
      }),
      deliveryKeySha256: key.keySha256,
    });
    expect(authority.publisher).toBe("host-owned");
    expect(authority.authorityExpansion).toBe(false);
    expect(authority.operations).toEqual([
      "push-namespaced-unprotected-non-default-branch",
      "create-or-reuse-draft-mr",
    ]);
    expect(decodeEffectiveAuthority(structuredClone(authority))).toEqual(authority);
  });

  it("allows artifact-only without a repository grant or SCM mutation", () => {
    const request = createDeliveryRequest(artifactInput());
    const authority = intersectEffectiveAuthority({
      request,
      requester: { entitlement: "none" },
      grant: null,
      workflowPolicy: openPolicy(),
      serviceCapability: hostService([]),
      scmState: scmState(),
      revalidation: {},
      deliveryKeySha256: deliveryKeyForRequest(request).keySha256,
    });
    expect(authority.grantSha256).toBeNull();
    expect(authority.operations).toEqual([]);
  });

  it("requires a host-minted fresh revalidation before create-draft-mr", () => {
    const request = createDeliveryRequest(requestInput());
    const key = deliveryKeyForRequest(request);
    const scm = scmState();
    const lookalike = {
      kind: "docsfab-fresh-delivery-revalidation",
      deliveryKeySha256: key.keySha256,
      scmStateSha256: scmStateSha256(scm),
    };
    expectCode(
      () =>
        intersectEffectiveAuthority({
          request,
          requester: { entitlement: "operator" },
          grant: contributeGrant(),
          workflowPolicy: openPolicy(),
          serviceCapability: hostService(),
          scmState: scm,
          revalidation: lookalike,
          deliveryKeySha256: key.keySha256,
        }),
      "revalidation-required",
    );
  });

  it("fails closed when grant, policy, or SCM state would widen authority", () => {
    const request = createDeliveryRequest(requestInput());
    const key = deliveryKeyForRequest(request);
    const scm = scmState();
    const revalidation = mintFreshDeliveryRevalidation({
      deliveryKeySha256: key.keySha256,
      scmStateSha256: scmStateSha256(scm),
    });
    expectCode(
      () =>
        intersectEffectiveAuthority({
          request,
          requester: { entitlement: "operator" },
          grant: reviewGrant(),
          workflowPolicy: openPolicy(),
          serviceCapability: hostService(),
          scmState: scm,
          revalidation,
          deliveryKeySha256: key.keySha256,
        }),
      "insufficient-grant",
    );
    expectCode(
      () =>
        intersectEffectiveAuthority({
          request,
          requester: { entitlement: "operator" },
          grant: contributeGrant(),
          workflowPolicy: {
            allowedIntents: ["artifact-only"],
            allowedControllers: ["one-shot"],
            allowedAuthorityBases: ["none"],
          },
          serviceCapability: hostService(),
          scmState: scm,
          revalidation,
          deliveryKeySha256: key.keySha256,
        }),
      "unsupported-combination",
    );
    expectCode(
      () =>
        intersectEffectiveAuthority({
          request,
          requester: { entitlement: "operator" },
          grant: contributeGrant(),
          workflowPolicy: openPolicy(),
          serviceCapability: hostService(),
          scmState: scmState({ sourceBranchProtected: true }),
          revalidation,
          deliveryKeySha256: key.keySha256,
        }),
      "revalidation-required",
    );
    const protectedScm = scmState({ sourceBranchProtected: true });
    expectCode(
      () =>
        intersectEffectiveAuthority({
          request,
          requester: { entitlement: "operator" },
          grant: contributeGrant(),
          workflowPolicy: openPolicy(),
          serviceCapability: hostService(),
          scmState: protectedScm,
          revalidation: mintFreshDeliveryRevalidation({
            deliveryKeySha256: key.keySha256,
            scmStateSha256: scmStateSha256(protectedScm),
          }),
          deliveryKeySha256: key.keySha256,
        }),
      "excluded-power",
    );
  });

  it("rejects a broker identity that claims the worker holds credentials", () => {
    const broker = createCredentialBrokerIdentityClass();
    expect(broker.workerHoldsCredentials).toBe(false);
    expectCode(
      () =>
        decodeCredentialBrokerIdentityClass({
          ...structuredClone(broker),
          workerHoldsCredentials: true,
        }),
      "authority-widening",
    );
  });
});

describe("v1 host job envelope compatibility projection", () => {
  it("projects a host-minted draft-mr envelope without expanding authority", () => {
    const envelope = mintHostJobEnvelope("run-once-fixture", {
      source: "cli-argv",
      allowWrite: true,
      draftMr: true,
    });
    const projection = projectHostMintedEnvelope(envelope);
    expect(projection.intent).toBe("create-draft-mr");
    expect(projection.authorityBasis).toBe("interactive-once");
    expect(projection.controller).toBe("one-shot");
    expect(projection.trigger).toBe("interactive");
    expect(projection.authorityExpansion).toBe(false);
  });

  it("projects a durable v1 publish:none record as artifact-only without minting", () => {
    const envelope = mintHostJobEnvelope("run-none", {
      source: "cli-argv",
      allowWrite: true,
      draftMr: false,
    });
    expect(projectHostMintedEnvelope(envelope)).toMatchObject({
      intent: "artifact-only",
      authorityBasis: "none",
      publish: "none",
      write: true,
    });
  });

  it("decodes a durable v1 none/draft-mr record as a constrained resume projection", () => {
    const record = {
      schemaVersion: 1 as const,
      kind: "docsfab-host-job-envelope" as const,
      write: true,
      publish: "draft-mr" as const,
      runId: "run-once-fixture",
    };
    const projection = projectV1HostJobEnvelopeRecord(record);
    expect(projection.intent).toBe("create-draft-mr");
    expect(projection.authorityBasis).toBe("interactive-once");
    expect(() => requireHostMintedEnvelope(record)).toThrow(/cannot be minted/u);
    expect(decodeHostJobEnvelopeProjection(structuredClone(projection))).toEqual(projection);
  });

  it("cannot reinterpret a v1 record as standing-grant, comment, or update authority", () => {
    expectCode(
      () =>
        projectV1HostJobEnvelopeRecord({
          schemaVersion: 1,
          kind: "docsfab-host-job-envelope",
          write: true,
          publish: "draft-mr",
          runId: "run-once-fixture",
          authorityBasis: "standing-repo-grant",
        }),
      "invalid-shape",
    );
    expectCode(
      () =>
        decodeHostJobEnvelopeProjection({
          schemaVersion: 1,
          kind: "docsfab-host-job-envelope-v1-projection",
          runId: "run-once-fixture",
          write: true,
          publish: "draft-mr",
          trigger: "webhook",
          intent: "comment-existing-mr",
          authorityBasis: "standing-repo-grant",
          controller: "bounded-reconcile",
          authorityExpansion: true,
          projectionSha256: HASH,
        }),
      "authority-widening",
    );
  });
});
