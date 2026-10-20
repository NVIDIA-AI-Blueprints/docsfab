// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SHA256 = /^[a-f0-9]{64}$/u;

/** @internal Host observation authority; intentionally absent from roadmap/index. */
export interface InternalManagedIssueObservationCapability {
  readonly kind: "docsfab-managed-issue-observation-capability";
}

const capabilities = new WeakMap<object, { sourceDigest: string }>();

export function internalIssueManagedIssueObservationCapability(
  sourceDigest: string,
): InternalManagedIssueObservationCapability {
  if (!SHA256.test(sourceDigest)) throw new Error("Managed issue observation source is invalid.");
  const capability = Object.freeze({
    kind: "docsfab-managed-issue-observation-capability" as const,
  });
  capabilities.set(capability, { sourceDigest });
  return capability;
}

export function internalManagedIssueObservationSourceDigest(
  capability: InternalManagedIssueObservationCapability,
): string | undefined {
  return capability && typeof capability === "object"
    ? capabilities.get(capability)?.sourceDigest
    : undefined;
}
