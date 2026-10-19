// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** The original host-validated assessment retained for a source-choice continuation. */
import { createContractKit } from "../contract-kit/index.js";

export const FIRST_PASS_REPLAY_KIND = "docsfab-first-pass-replay" as const;

export interface FirstPassReplayV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof FIRST_PASS_REPLAY_KIND;
  readonly snapshot: unknown;
  readonly support: unknown;
  readonly targetPaths: readonly string[];
  readonly assessmentIdentitySha256: string;
  readonly assessmentBindingSha256: string;
  readonly replaySha256: string;
}

export class FirstPassReplayError extends Error {
  public constructor() {
    super("The saved first-pass assessment is malformed.");
    this.name = "FirstPassReplayError";
  }
}

const fail = (): never => {
  throw new FirstPassReplayError();
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

function body(root: Record<string, unknown>) {
  const targetPaths = kit.array(root.targetPaths).map((value) => kit.string(value));
  if (targetPaths.length === 0 || targetPaths.some((path) => !path)) fail();
  kit.unique(targetPaths);
  return {
    snapshot: kit.object(root.snapshot),
    support: kit.object(root.support),
    targetPaths,
    assessmentIdentitySha256: kit.hash(root.assessmentIdentitySha256),
    assessmentBindingSha256: kit.hash(root.assessmentBindingSha256),
  };
}

export function createFirstPassReplay(
  input: Omit<FirstPassReplayV1, "schemaVersion" | "kind" | "replaySha256">,
): FirstPassReplayV1 {
  return kit.seal(FIRST_PASS_REPLAY_KIND, "replaySha256", body(input));
}

export function decodeFirstPassReplay(value: unknown): FirstPassReplayV1 {
  return kit.decodeSealed(
    value,
    FIRST_PASS_REPLAY_KIND,
    "replaySha256",
    ["snapshot", "support", "targetPaths", "assessmentIdentitySha256", "assessmentBindingSha256"],
    body,
  );
}
