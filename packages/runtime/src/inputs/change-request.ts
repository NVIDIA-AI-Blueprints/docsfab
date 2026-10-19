// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable, provider-independent identity of one repository-scoped code change. */
import { createContractKit } from "../contract-kit/index.js";

export const CHANGE_REQUEST_REF_KIND = "docsfab-change-request-ref" as const;
export type ChangeRequestProvider = "github" | "gitlab";
export type ChangeRequestObjectKind = "pull-request" | "merge-request";

export interface ChangeRequestRefV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof CHANGE_REQUEST_REF_KIND;
  readonly provider: ChangeRequestProvider;
  readonly canonicalHost: string;
  /** Native stable target ID, not a mutable owner/repository slug. */
  readonly targetRepositoryId: string;
  readonly objectKind: ChangeRequestObjectKind;
  /** Repository-scoped native number, in its canonical decimal spelling. */
  readonly nativeChangeId: string;
  readonly referenceSha256: string;
}

export type ChangeRequestErrorCode =
  | "change-request-invalid-shape"
  | "change-request-invalid-value"
  | "change-request-credential-material"
  | "change-request-schema-mismatch"
  | "change-request-digest-mismatch";

export class ChangeRequestError extends Error {
  constructor(readonly code: ChangeRequestErrorCode) {
    super(code);
    this.name = "ChangeRequestError";
  }
}

function fail(code: ChangeRequestErrorCode): never {
  throw new ChangeRequestError(code);
}

const kit = createContractKit<ChangeRequestErrorCode>({
  fail,
  codes: {
    invalidShape: "change-request-invalid-shape",
    invalidValue: "change-request-invalid-value",
    credentialMaterial: "change-request-credential-material",
    schemaMismatch: "change-request-schema-mismatch",
    digestMismatch: "change-request-digest-mismatch",
  },
});

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;

function host(value: unknown): string {
  const name = kit.string(value);
  if (!HOST.test(name)) fail("change-request-invalid-value");
  return name;
}

function nativeNumber(value: unknown): string {
  const name = kit.string(value);
  if (!POSITIVE_DECIMAL.test(name) || !Number.isSafeInteger(Number(name)))
    fail("change-request-invalid-value");
  return name;
}

function body(root: Record<string, unknown>) {
  const provider = kit.enumeration(root.provider, ["github", "gitlab"] as const);
  const objectKind = kit.enumeration(root.objectKind, ["pull-request", "merge-request"] as const);
  if (
    (provider === "github" && objectKind !== "pull-request") ||
    (provider === "gitlab" && objectKind !== "merge-request")
  )
    fail("change-request-invalid-value");
  const canonicalHost = host(root.canonicalHost);
  if (provider === "github" && canonicalHost !== "github.com") fail("change-request-invalid-value");
  return {
    provider,
    canonicalHost,
    targetRepositoryId: nativeNumber(root.targetRepositoryId),
    objectKind,
    nativeChangeId: nativeNumber(root.nativeChangeId),
  };
}

const BODY_KEYS = [
  "provider",
  "canonicalHost",
  "targetRepositoryId",
  "objectKind",
  "nativeChangeId",
];

export function createChangeRequestRef(
  input: Pick<
    ChangeRequestRefV1,
    "provider" | "canonicalHost" | "targetRepositoryId" | "objectKind" | "nativeChangeId"
  >,
): ChangeRequestRefV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const root = kit.object(input);
  kit.exact(root, BODY_KEYS);
  return kit.seal(CHANGE_REQUEST_REF_KIND, "referenceSha256", body(root));
}

/** Decoding verifies a seal; it never grants a forge, Git, or source reader. */
export function decodeChangeRequestRef(value: unknown): ChangeRequestRefV1 {
  return kit.decodeSealed(value, CHANGE_REQUEST_REF_KIND, "referenceSha256", BODY_KEYS, body);
}
