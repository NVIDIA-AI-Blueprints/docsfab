// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, deepFreeze, type ContractFail } from "../contract-kit/index.js";
import { redactCredentialMaterial } from "../security/credential-material.js";

/** Display evidence only. Deletion still requires a fresh preview and its confirmation. */
export interface RunRetainedDeliveryV1 {
  readonly status: "retained" | "inspection-required";
  readonly worktrees: readonly string[];
  readonly branches: readonly string[];
  readonly keptBranches: readonly string[];
  readonly cleanupPreviewCommand: string | null;
  readonly explanation: string | null;
}

const fail: ContractFail<"invalid"> = () => {
  throw new Error("The retained delivery display does not match its contract.");
};
const kit = createContractKit<"invalid">({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid",
    invalidValue: "invalid",
    digestMismatch: "invalid",
    credentialMaterial: "invalid",
    schemaMismatch: "invalid",
  },
});

function displayString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    redactCredentialMaterial(value) !== value
  )
    return fail("invalid");
  return value;
}

export function decodeRunRetainedDeliveryV1(value: unknown): RunRetainedDeliveryV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "status",
    "worktrees",
    "branches",
    "keptBranches",
    "cleanupPreviewCommand",
    "explanation",
  ]);
  kit.enumeration(root.status, ["retained", "inspection-required"] as const);
  for (const key of ["worktrees", "branches", "keptBranches"] as const) {
    const entries = kit.array(root[key]).map(displayString);
    if (new Set(entries).size !== entries.length) fail("invalid");
  }
  if (root.cleanupPreviewCommand !== null) displayString(root.cleanupPreviewCommand);
  if (root.explanation !== null) displayString(root.explanation);
  if (root.status === "inspection-required" && root.explanation === null) fail("invalid");
  return root as unknown as RunRetainedDeliveryV1;
}

export function unavailableRunRetainedDelivery(): RunRetainedDeliveryV1 {
  return deepFreeze({
    status: "inspection-required",
    worktrees: [],
    branches: [],
    keptBranches: [],
    cleanupPreviewCommand: null,
    explanation:
      "Retained delivery details could not be verified or displayed safely. Inspect the original private publication roots, then preview deletion of this saved run.",
  });
}

/** Explicit projection keeps private receipts, claims, and deletion tokens out of output. */
export function projectRunRetainedDeliveryV1(input: RunRetainedDeliveryV1): RunRetainedDeliveryV1 {
  try {
    kit.object(input);
    const value = {
      status: input.status,
      worktrees: [...new Set(input.worktrees)].sort(),
      branches: [...new Set(input.branches)].sort(),
      keptBranches: [...new Set(input.keptBranches)].sort(),
      cleanupPreviewCommand: input.cleanupPreviewCommand,
      explanation: input.explanation,
    };
    return deepFreeze(decodeRunRetainedDeliveryV1(value));
  } catch {
    // A redacted path cannot be offered as an executable cleanup command.
    return unavailableRunRetainedDelivery();
  }
}
