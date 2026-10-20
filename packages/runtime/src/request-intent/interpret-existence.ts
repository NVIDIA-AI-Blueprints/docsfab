// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The existence answers admission reads, from the plan-binding collision
 * oracle the runner itself uses for a planned CREATE.
 *
 * The oracle is a port so the interpretation stays pure: production binds
 * `plannedTargetCollisions` over the run's workspace, before the run's first
 * write. The mapping is total over the oracle's answer shape and keyed by the
 * asked path, so the answers come back in the asked order whatever order the
 * oracle returns.
 */
import type { PlannedTargetCollisionV1 } from "../workflow-execution/plan-binding.js";
import type { RequestIntentExistenceAnswer, RequestIntentExistenceKind } from "./contract.js";
import { RequestIntentContractError } from "./kit.js";

/** How the asked `write`-role paths exist at the run's revision; one collision per existing path. */
export type RequestIntentExistenceOracle = (
  paths: readonly string[],
) => Promise<readonly PlannedTargetCollisionV1[]>;

/**
 * One collision's existence kind. A refused update grant wins over every other
 * field, because no update of that page can be delivered; an exact-case file
 * is `file` only with a base, the one editable page the path names; a file
 * collision without a base is a fold, link, submodule, or excluded entry.
 */
export function requestIntentExistenceKind(
  collision: PlannedTargetCollisionV1 | undefined,
): RequestIntentExistenceKind {
  if (collision === undefined) return "absent";
  if (collision.updateRefused === "write-grant") return "file-not-granted";
  switch (collision.existing) {
    case "file":
      return collision.base ? "file" : "case-fold";
    case "directory":
    case "parent-file":
      return collision.existing;
  }
}

/**
 * One answer per asked path, in asked order. A collision for a path nobody
 * asked about, or two for one path, means the oracle answered another
 * question: a host fault, never a guess.
 */
export function requestIntentExistenceAnswers(
  asked: readonly string[],
  collisions: readonly PlannedTargetCollisionV1[],
): RequestIntentExistenceAnswer[] {
  const askedSet = new Set(asked);
  const byPath = new Map<string, PlannedTargetCollisionV1>();
  for (const collision of collisions) {
    if (!askedSet.has(collision.path) || byPath.has(collision.path)) {
      throw new RequestIntentContractError(
        "host-input-invalid",
        "the existence oracle answered a path the interpretation did not ask about, or one path twice.",
      );
    }
    byPath.set(collision.path, collision);
  }
  return asked.map((path) => ({
    path,
    existing: requestIntentExistenceKind(byPath.get(path)),
  }));
}
