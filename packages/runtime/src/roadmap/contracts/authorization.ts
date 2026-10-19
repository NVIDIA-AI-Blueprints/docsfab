// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RepositoryIdentity } from "../../content-ir/contracts.js";
import {
  ROADMAP_LEDGER_SCHEMA_VERSION,
  internalRoadmapIdentity,
  type RoadmapLedger,
  type RoadmapProjectIdentity,
  type RoadmapTrackerObservation,
} from "./ledger.js";
import {
  validateRoadmapMutationPlan,
  type RoadmapMutationOperation,
  type RoadmapMutationPlan,
} from "./mutation.js";
import {
  RoadmapContractError,
  internalRoadmapDecode,
  roadmapDigest,
  type RoadmapContractErrorCode,
} from "./decode.js";

const { closed, identifier, timestamp, digest, enumeration, idArray, requireUnique, freeze } =
  internalRoadmapDecode;

const requireValue: (
  condition: unknown,
  code: RoadmapContractErrorCode,
  path: string,
) => asserts condition = internalRoadmapDecode.requireValue;

const { repository, project, sameRepository, sameProject } = internalRoadmapIdentity;

export interface RoadmapMutationAuthorization {
  kind: "roadmap-mutation-authorization";
  schemaVersion: typeof ROADMAP_LEDGER_SCHEMA_VERSION;
  id: string;
  planDigest: string;
  repository: RepositoryIdentity;
  project: RoadmapProjectIdentity;
  authorizedOperationKeys: string[];
  authority: { kind: "local-user" | "host-policy"; id: string };
  decision: "approved";
  issuedAt: string;
  expiresAt: string;
  digest: string;
}

export function createRoadmapMutationAuthorization(
  input: Omit<
    RoadmapMutationAuthorization,
    "kind" | "schemaVersion" | "digest" | "planDigest" | "repository" | "project" | "decision"
  >,
  plan: RoadmapMutationPlan,
  ledger: RoadmapLedger,
): RoadmapMutationAuthorization {
  validateRoadmapMutationPlan(plan, { ledger });
  const candidate = {
    kind: "roadmap-mutation-authorization" as const,
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    ...input,
    planDigest: plan.digest,
    repository: plan.repository,
    project: plan.project,
    authorizedOperationKeys: [...input.authorizedOperationKeys].sort(),
    decision: "approved" as const,
    digest: "0".repeat(64),
  };
  candidate.digest = roadmapDigest(candidate);
  return validateRoadmapMutationAuthorization(candidate, plan, ledger);
}

export function validateRoadmapMutationAuthorization(
  value: unknown,
  plan: RoadmapMutationPlan,
  ledger: RoadmapLedger,
  now?: Date,
): RoadmapMutationAuthorization {
  validateRoadmapMutationPlan(plan, { ledger, ...(now === undefined ? {} : { now }) });
  const root = closed(value, "$", [
    "kind",
    "schemaVersion",
    "id",
    "planDigest",
    "repository",
    "project",
    "authorizedOperationKeys",
    "authority",
    "decision",
    "issuedAt",
    "expiresAt",
    "digest",
  ]);
  requireValue(
    root.kind === "roadmap-mutation-authorization" &&
      root.schemaVersion === ROADMAP_LEDGER_SCHEMA_VERSION &&
      root.decision === "approved",
    "invalid-value",
    "$",
  );
  const authorityRoot = closed(root.authority, "$.authority", ["kind", "id"]);
  const authorization: RoadmapMutationAuthorization = {
    kind: "roadmap-mutation-authorization",
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    id: identifier(root.id, "$.id"),
    planDigest: digest(root.planDigest, "$.planDigest"),
    repository: repository(root.repository, "$.repository"),
    project: project(root.project, "$.project"),
    authorizedOperationKeys: idArray(root.authorizedOperationKeys, "$.authorizedOperationKeys"),
    authority: {
      kind: enumeration(
        authorityRoot.kind,
        ["local-user", "host-policy"] as const,
        "$.authority.kind",
      ),
      id: identifier(authorityRoot.id, "$.authority.id"),
    },
    decision: "approved",
    issuedAt: timestamp(root.issuedAt, "$.issuedAt"),
    expiresAt: timestamp(root.expiresAt, "$.expiresAt"),
    digest: digest(root.digest, "$.digest"),
  };
  requireValue(authorization.planDigest === plan.digest, "digest-mismatch", "$.planDigest");
  requireValue(
    sameRepository(authorization.repository, plan.repository),
    "repository-mismatch",
    "$.repository",
  );
  requireValue(sameProject(authorization.project, plan.project), "project-mismatch", "$.project");
  requireValue(
    authorization.authorizedOperationKeys.length > 0,
    "invalid-value",
    "$.authorizedOperationKeys",
  );
  const planned = new Set(plan.operations.map((item) => item.key));
  const authorized = new Set(authorization.authorizedOperationKeys);
  for (const key of authorization.authorizedOperationKeys) {
    requireValue(planned.has(key), "operation-expansion", "$.authorizedOperationKeys");
    const operation = plan.operations.find((item) => item.key === key)!;
    for (const dependency of operation.dependsOnOperationKeys) {
      requireValue(
        authorized.has(dependency),
        "unresolved-dependency",
        "$.authorizedOperationKeys",
      );
    }
  }
  requireValue(
    Date.parse(plan.generatedAt) <= Date.parse(authorization.issuedAt),
    "invalid-time",
    "$.issuedAt",
  );
  requireValue(
    Date.parse(authorization.issuedAt) <= Date.parse(authorization.expiresAt),
    "invalid-time",
    "$.expiresAt",
  );
  requireValue(
    Date.parse(authorization.expiresAt) <= Date.parse(plan.expiresAt),
    "invalid-time",
    "$.expiresAt",
  );
  if (now)
    requireValue(
      Date.parse(authorization.issuedAt) <= now.valueOf() &&
        now.valueOf() <= Date.parse(authorization.expiresAt),
      "expired",
      "$.expiresAt",
    );
  requireValue(
    roadmapDigest(authorization) === authorization.digest,
    "digest-mismatch",
    "$.digest",
  );
  return freeze(authorization);
}

export function assertRoadmapOperationAuthorized(
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlan,
  authorization: RoadmapMutationAuthorization,
  operationKey: string,
  now: Date,
  currentTracker: RoadmapTrackerObservation[],
): RoadmapMutationOperation {
  void ledger;
  void plan;
  void authorization;
  void operationKey;
  void now;
  void currentTracker;
  throw new RoadmapContractError("replan-required", "$.schemaVersion");
}
