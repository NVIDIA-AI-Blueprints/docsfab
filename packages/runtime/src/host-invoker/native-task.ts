// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Inert task selection for hosted native operations; never an approval or write grant. */
import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import { validateArtifactReference } from "../artifacts/validate.js";
import type { ArtifactReference } from "../artifacts/contracts.js";
import type { ContextPreflightTarget } from "../context/contracts.js";
import type { IaPlanTaskInput } from "../workflow-contracts/contracts.js";
import { HostRuntimeContractError } from "./contract-error.js";

export const HOST_RUNTIME_NATIVE_TASK_KIND = "docsfab-host-native-task" as const;
/** Task vocabulary only. Executor installation is a separate catalog decision. */
export const HOST_RUNTIME_NATIVE_WORKFLOWS = [
  "foundation",
  "foundation-to-patch",
  "ia-analysis",
  "ia-plan",
  "site-bootstrap",
] as const;
export type HostRuntimeNativeWorkflow = (typeof HOST_RUNTIME_NATIVE_WORKFLOWS)[number];

/** A retained job receipt selects an artifact in that job's authenticated output set. */
export interface HostRuntimeNativeInputReferenceV1 {
  readonly receiptLocator: string;
  readonly artifactSha256: string;
}

/**
 * Verified, separately registered signed-plan provenance; never task-supplied.
 *
 * The host writes this row only after an operator import has verified the
 * reviewer's signature over the approved plan. It travels beside the selected
 * bytes so the executor can bind them to that registration without believing
 * anything the task said about it.
 */
export interface HostRuntimeApprovedNativeImportV1 {
  readonly kind: "site-bootstrap-approval";
  readonly receiptLocator: string;
  readonly receiptSha256: string;
  readonly authorityReceiptSha256: string;
  readonly reviewerPolicySha256: string;
  readonly reviewerPolicyContentSha256: string;
  readonly reviewerPolicyBytes: number;
}

/** Host-resolved data custody, separate from the caller's task and from approval. */
export interface HostRuntimeResolvedNativeInputV1 {
  readonly recordKey: string;
  readonly contentSha256: string;
  readonly bytes: Uint8Array;
  readonly approvedImport?: HostRuntimeApprovedNativeImportV1;
  readonly source: {
    readonly requestKey: string;
    readonly runId: string;
    readonly principalId: string;
    readonly workflow: string;
    readonly revision: string;
    readonly repositoryIdentitySha256: string;
    readonly receiptLocator: string;
    readonly receiptSha256: string;
  };
}

export type HostRuntimeNativeTaskPayloadV1 =
  | { readonly kind: "foundation" }
  | {
      readonly kind: "foundation-to-patch";
      readonly intendedPaths: readonly string[];
    }
  | IaPlanTaskInput
  | { readonly kind: "site-bootstrap"; readonly plan: ArtifactReference<"ia-plan"> };

export interface HostRuntimeNativeTaskV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HOST_RUNTIME_NATIVE_TASK_KIND;
  readonly workflow: HostRuntimeNativeWorkflow;
  readonly task: HostRuntimeNativeTaskPayloadV1;
  readonly inputs: readonly HostRuntimeNativeInputReferenceV1[];
  readonly taskSha256: string;
}

function fail(code: string): never {
  throw new HostRuntimeContractError(`native-task-${code}`);
}
const kit = createContractKit({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-version",
  },
});

/** Canonical `ia-plan` reference codec, shared with the host's approved-import receipt. */
export function parseHostRuntimeNativePlanReference(value: unknown): ArtifactReference<"ia-plan"> {
  return validateArtifactReference(value, {
    expectedKind: "ia-plan",
  }) as ArtifactReference<"ia-plan">;
}

/**
 * Repository-relative documentation path, as the tracked tree spells it.
 *
 * Refuses an absolute path, a backslash or colon (host-dependent meaning), and
 * any empty, `.` or `..` segment. `kit.string` already refuses non-strings,
 * non-NFC text and NUL (a NUL path as `native-task-invalid-value`).
 *
 * Control characters and a `~` prefix are not screened here. Nothing on this
 * wire path is exempt from a prose screen; the Slack grammar, which exempts
 * path fields from `rejectUnsafeContent`, closes that gap beside its exemption
 * (`packages/host/src/slack-slash/native-task.ts`).
 *
 * Credentials are screened by `kit.rejectCredentials` in
 * `sealHostRuntimeNativeTask`. That vocabulary lacks the host dialect's
 * `label=value` rule, so the two screens complement rather than back up each
 * other.
 */
function repositoryPath(value: unknown): string {
  const path = kit.string(value);
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("repository-path");
  }
  return path;
}

function target(value: unknown): Pick<ContextPreflightTarget, "sourcePath" | "anchor"> {
  const row = kit.object(value);
  kit.exact(row, ["sourcePath", "anchor"], ["anchor"]);
  return {
    sourcePath: repositoryPath(row.sourcePath),
    ...(row.anchor === undefined ? {} : { anchor: kit.string(row.anchor) }),
  };
}

function payload(
  value: unknown,
  workflow: HostRuntimeNativeWorkflow,
): HostRuntimeNativeTaskPayloadV1 {
  const row = kit.object(value);
  if (workflow === "foundation") {
    kit.exact(row, ["kind"]);
    if (row.kind !== "foundation") fail("workflow-binding");
    return { kind: "foundation" };
  }
  if (workflow === "foundation-to-patch") {
    kit.exact(row, ["kind", "intendedPaths"]);
    if (row.kind !== workflow) fail("workflow-binding");
    const intendedPaths = kit.array(row.intendedPaths).map(repositoryPath);
    // Empty means "patch nothing"; a repeated path would be patched twice.
    // `kit.array` has already applied the catalogued count ceiling.
    if (!intendedPaths.length || new Set(intendedPaths).size !== intendedPaths.length)
      fail("intended-paths");
    return { kind: workflow, intendedPaths };
  }
  if (workflow === "site-bootstrap") {
    kit.exact(row, ["kind", "plan"]);
    if (row.kind !== workflow) fail("workflow-binding");
    const plan = parseHostRuntimeNativePlanReference(row.plan);
    return { kind: workflow, plan };
  }
  kit.exact(row, ["kind", "scope", "mode", "target"], ["target"]);
  if (row.kind !== "ia-plan") fail("workflow-binding");
  const scope = kit.enumeration(row.scope, ["site", "section", "page"] as const);
  // `site` covers the whole documentation set and names no target; `section`
  // and `page` name exactly one.
  if ((scope === "site") === (row.target !== undefined)) fail("ia-target-binding");
  return {
    kind: "ia-plan",
    scope,
    mode: kit.enumeration(row.mode, ["create", "reevaluate"] as const),
    ...(row.target === undefined ? {} : { target: target(row.target) }),
  };
}

function normalize(root: Record<string, unknown>) {
  kit.exact(root, ["workflow", "task", "inputs"]);
  const workflow = kit.enumeration(root.workflow, HOST_RUNTIME_NATIVE_WORKFLOWS);
  const inputs = kit.array(root.inputs).map((value) => {
    const row = kit.object(value);
    kit.exact(row, ["receiptLocator", "artifactSha256"]);
    const receiptLocator = kit.string(row.receiptLocator);
    if (!/^cas:[a-f0-9]{32}:[a-f0-9]{64}$/u.test(receiptLocator)) fail("receipt-locator");
    return { receiptLocator, artifactSha256: kit.hash(row.artifactSha256) };
  });
  // The same artifact in the same receipt is one selection written twice.
  // Sharing only the receipt or only the digest selects different bytes.
  if (
    new Set(inputs.map((input) => `${input.receiptLocator}:${input.artifactSha256}`)).size !==
    inputs.length
  ) {
    fail("duplicate-input");
  }
  return { workflow, task: payload(root.task, workflow), inputs };
}

export function sealHostRuntimeNativeTask(
  input: Omit<HostRuntimeNativeTaskV1, "schemaVersion" | "kind" | "taskSha256">,
): HostRuntimeNativeTaskV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return deepFreeze(
    kit.seal(HOST_RUNTIME_NATIVE_TASK_KIND, "taskSha256", normalize(kit.object(input))),
  ) as HostRuntimeNativeTaskV1;
}

export function parseHostRuntimeNativeTask(value: unknown): HostRuntimeNativeTaskV1 {
  return deepFreeze(
    kit.decodeSealed(
      value,
      HOST_RUNTIME_NATIVE_TASK_KIND,
      "taskSha256",
      ["workflow", "task", "inputs"],
      normalize,
    ),
  ) as HostRuntimeNativeTaskV1;
}
