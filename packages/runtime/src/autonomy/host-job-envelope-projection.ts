// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * v1 host job envelope `{ write, publish: none | draft-mr }` as a constrained
 * compatibility projection. Decoding a durable v1 record never mints authority
 * and never widens to standing-grant or existing-MR modes.
 */

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  DeliveryAuthorityError,
  failDeliveryAuthority,
  type AuthorityBasis,
  type DeliveryController,
  type DeliveryIntent,
  type DeliveryTrigger,
} from "../delivery/delivery-authority.js";

export const HOST_JOB_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const HOST_JOB_ENVELOPE_KIND = "docsfab-host-job-envelope" as const;
export type HostJobPublishCapability = "none" | "draft-mr";

export interface V1HostJobEnvelopeRecord {
  readonly schemaVersion: typeof HOST_JOB_ENVELOPE_SCHEMA_VERSION;
  readonly kind: typeof HOST_JOB_ENVELOPE_KIND;
  readonly write: boolean;
  readonly publish: HostJobPublishCapability;
  readonly runId: string;
}

export interface HostJobEnvelopeProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-host-job-envelope-v1-projection";
  runId: string;
  write: boolean;
  publish: HostJobPublishCapability;
  trigger: Extract<DeliveryTrigger, "interactive">;
  intent: Extract<DeliveryIntent, "artifact-only" | "create-draft-mr">;
  authorityBasis: Extract<AuthorityBasis, "none" | "interactive-once">;
  controller: Extract<DeliveryController, "one-shot">;
  authorityExpansion: false;
  projectionSha256: string;
}

const kit = createContractKit({
  fail: failDeliveryAuthority as ContractFail<DeliveryAuthorityError["code"]>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Extra fields in a persisted record cannot mint standing-repo-grant, webhook,
 * comment, update-existing-mr, or bounded-reconcile authority.
 */
export function projectV1HostJobEnvelopeRecord(value: unknown): HostJobEnvelopeProjectionV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "kind", "write", "publish", "runId"]);
  if (root.schemaVersion !== HOST_JOB_ENVELOPE_SCHEMA_VERSION) {
    failDeliveryAuthority("migration-required");
  }
  if (root.kind !== HOST_JOB_ENVELOPE_KIND) failDeliveryAuthority("invalid-value");
  const write = booleanValue(root.write);
  const publish = kit.enumeration(root.publish, ["none", "draft-mr"] as const);
  if (publish === "draft-mr" && !write) failDeliveryAuthority("invalid-value");
  const runId = kit.string(root.runId);
  if (!SAFE_RUN_ID.test(runId)) failDeliveryAuthority("invalid-value");
  const intent = publish === "draft-mr" ? "create-draft-mr" : "artifact-only";
  const authorityBasis = publish === "draft-mr" ? "interactive-once" : "none";
  return kit.seal("docsfab-host-job-envelope-v1-projection", "projectionSha256", {
    runId,
    write,
    publish,
    trigger: "interactive" as const,
    intent,
    authorityBasis,
    controller: "one-shot" as const,
    authorityExpansion: false as const,
  });
}

export function decodeHostJobEnvelopeProjection(value: unknown): HostJobEnvelopeProjectionV1 {
  return kit.decodeSealed(
    value,
    "docsfab-host-job-envelope-v1-projection",
    "projectionSha256",
    [
      "runId",
      "write",
      "publish",
      "trigger",
      "intent",
      "authorityBasis",
      "controller",
      "authorityExpansion",
    ],
    (root) => {
      if (root.authorityExpansion !== false) failDeliveryAuthority("authority-widening");
      if (root.trigger !== "interactive") failDeliveryAuthority("authority-widening");
      if (root.controller !== "one-shot") failDeliveryAuthority("authority-widening");
      const publish = kit.enumeration(root.publish, ["none", "draft-mr"] as const);
      const intent = kit.enumeration(root.intent, ["artifact-only", "create-draft-mr"] as const);
      const authorityBasis = kit.enumeration(root.authorityBasis, [
        "none",
        "interactive-once",
      ] as const);
      if (publish === "none" && (intent !== "artifact-only" || authorityBasis !== "none")) {
        failDeliveryAuthority("authority-widening");
      }
      if (
        publish === "draft-mr" &&
        (intent !== "create-draft-mr" || authorityBasis !== "interactive-once")
      ) {
        failDeliveryAuthority("authority-widening");
      }
      const projection = projectV1HostJobEnvelopeRecord({
        schemaVersion: 1,
        kind: HOST_JOB_ENVELOPE_KIND,
        write: booleanValue(root.write),
        publish,
        runId: kit.string(root.runId),
      });
      return {
        runId: projection.runId,
        write: projection.write,
        publish: projection.publish,
        trigger: projection.trigger,
        intent: projection.intent,
        authorityBasis: projection.authorityBasis,
        controller: projection.controller,
        authorityExpansion: false as const,
      };
    },
  );
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") failDeliveryAuthority("invalid-value");
  return value;
}
