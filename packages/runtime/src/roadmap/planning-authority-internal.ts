// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

const SHA = /^[a-f0-9]{64}$/u;

/** @internal Host adapter authority. This module is intentionally absent from roadmap/index. */
export interface InternalRoadmapPlanningSourceCapability {
  readonly kind: "roadmap-planning-source-capability";
}
export interface InternalRoadmapPlanningHostAuthority {
  readonly kind: "roadmap-planning-host-authority";
}
export interface InternalRoadmapPlanningSourceState {
  sourceDigest: string;
  sourceAuthorityId: string;
  artifactDigest?: string;
}

const SOURCE_AUTHORITIES = new WeakMap<object, InternalRoadmapPlanningSourceState>();
const HOST_AUTHORITIES = new WeakMap<object, { trustedSourceDigest: string }>();

export function internalCreateRoadmapPlanningHostAuthority(
  trustedSourceDigest: string,
): InternalRoadmapPlanningHostAuthority {
  if (!SHA.test(trustedSourceDigest))
    throw new Error("Host roadmap source authority digest is invalid.");
  const authority = Object.freeze({ kind: "roadmap-planning-host-authority" as const });
  HOST_AUTHORITIES.set(authority, { trustedSourceDigest });
  return authority;
}

export function internalIssueRoadmapPlanningSourceCapability(
  hostAuthority: InternalRoadmapPlanningHostAuthority,
  sourceDigest: string,
): InternalRoadmapPlanningSourceCapability {
  const host =
    hostAuthority && typeof hostAuthority === "object"
      ? HOST_AUTHORITIES.get(hostAuthority)
      : undefined;
  if (!host || host.trustedSourceDigest !== sourceDigest)
    throw new Error("Host roadmap source authority does not match the reviewed source.");
  const capability = Object.freeze({ kind: "roadmap-planning-source-capability" as const });
  SOURCE_AUTHORITIES.set(capability, {
    sourceDigest,
    sourceAuthorityId: `authority:${randomBytes(32).toString("hex")}`,
  });
  return capability;
}

export function internalRoadmapPlanningSourceState(
  value: InternalRoadmapPlanningSourceCapability,
): InternalRoadmapPlanningSourceState | undefined {
  return value && typeof value === "object" ? SOURCE_AUTHORITIES.get(value) : undefined;
}
