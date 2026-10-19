// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RepositoryIdentity } from "../../content-ir/contracts.js";
import type { RoadmapProjectIdentity } from "../contracts/ledger.js";
import type { RoadmapLedgerReference } from "../contracts/mutation.js";
import {
  HOST,
  REVISION,
  closed,
  digest,
  identifier,
  positiveInteger,
  requireValue,
} from "./primitives.js";

export function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.revision === right.revision && left.contentDigest === right.contentDigest;
}
export function sameProject(left: RoadmapProjectIdentity, right: RoadmapProjectIdentity): boolean {
  return (
    left.provider === right.provider &&
    left.host === right.host &&
    left.fullPath === right.fullPath &&
    left.projectId === right.projectId
  );
}
export function repository(value: unknown, path: string): RepositoryIdentity {
  const item = closed(value, path, ["revision", "contentDigest"]);
  requireValue(
    typeof item.revision === "string" && REVISION.test(item.revision),
    "invalid-value",
    `${path}.revision`,
  );
  return {
    revision: item.revision,
    contentDigest: digest(item.contentDigest, `${path}.contentDigest`),
  };
}

export function project(value: unknown, path: string): RoadmapProjectIdentity {
  const item = closed(value, path, ["provider", "host", "fullPath", "projectId"]);
  const provider = identifier(item.provider, `${path}.provider`);
  requireValue(
    !provider.includes(":") && !provider.includes("/") && provider.length <= 64,
    "invalid-value",
    `${path}.provider`,
  );
  requireValue(typeof item.host === "string" && HOST.test(item.host), "invalid-value", path);
  const fullPath = identifier(item.fullPath, `${path}.fullPath`);
  requireValue(
    fullPath.includes("/") && !fullPath.startsWith("/") && !fullPath.endsWith("/"),
    "invalid-value",
    `${path}.fullPath`,
  );
  return {
    provider,
    host: item.host,
    fullPath,
    projectId: positiveInteger(item.projectId, `${path}.projectId`),
  };
}

export function ledgerReference(value: unknown, path: string): RoadmapLedgerReference {
  const item = closed(value, path, [
    "kind",
    "schemaVersion",
    "digest",
    "repositoryRevision",
    "repositoryContentDigest",
  ]);
  requireValue(item.kind === "roadmap-ledger" && item.schemaVersion === 1, "invalid-value", path);
  requireValue(
    typeof item.repositoryRevision === "string" && REVISION.test(item.repositoryRevision),
    "invalid-value",
    `${path}.repositoryRevision`,
  );
  return {
    kind: "roadmap-ledger",
    schemaVersion: 1,
    digest: digest(item.digest, `${path}.digest`),
    repositoryRevision: item.repositoryRevision,
    repositoryContentDigest: digest(
      item.repositoryContentDigest,
      `${path}.repositoryContentDigest`,
    ),
  };
}
