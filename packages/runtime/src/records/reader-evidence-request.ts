// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run record's `readerEvidenceRequest` contract: the comparison request and
 * explicit reader-source nominations the operator gave an update run, kept so
 * an InputAsk continuation re-admits the same evidence instead of asking for a
 * comparison it cannot fill. The writer and every strict reader share this
 * module so they agree on the shape.
 *
 * Only operator-supplied values are kept: never a handoff-derived comparison,
 * a merged-MR-assembled source, a host default, or source bytes. The stored
 * comparison is the request, not a resolved snapshot, so `workspace`
 * re-resolves at the continued run's revision.
 */
import { limitDefinition } from "../config/limits.js";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  READER_SOURCE_NOMINATIONS_LIMIT,
  parseReaderSourceHintV1,
  type ReaderSourceHintV1,
} from "../execution/reader-task-admission.js";
import type { ReaderComparisonRequestV1 } from "../search/change-impact.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";

export interface RunRecordReaderEvidenceRequestV1 {
  readonly comparisonRequest?: ReaderComparisonRequestV1;
  readonly readerSources?: readonly ReaderSourceHintV1[];
}

/** The one workflow whose arguments accept a comparison or reader sources. */
const READER_EVIDENCE_WORKFLOW: WorkflowName = "update-documentation";

export class RunRecordReaderEvidenceRequestError extends Error {
  constructor() {
    super("Run record readerEvidenceRequest does not match the reader evidence request contract.");
    this.name = "RunRecordReaderEvidenceRequestError";
  }
}

const fail: ContractFail<"invalid"> = () => {
  throw new RunRecordReaderEvidenceRequestError();
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

/**
 * The value the writer keeps, or `undefined` when the run had neither a
 * comparison nor a nomination: such a record carries no field at all.
 */
export function retainedReaderEvidenceRequest(input: {
  readonly comparisonRequest?: ReaderComparisonRequestV1;
  readonly readerSources?: readonly ReaderSourceHintV1[];
}): RunRecordReaderEvidenceRequestV1 | undefined {
  const readerSources = input.readerSources ?? [];
  if (input.comparisonRequest === undefined && readerSources.length === 0) return undefined;
  return {
    ...(input.comparisonRequest
      ? { comparisonRequest: structuredClone(input.comparisonRequest) }
      : {}),
    ...(readerSources.length > 0
      ? { readerSources: readerSources.map(({ role, path }) => ({ role, path })) }
      : {}),
  };
}

/**
 * Admit only what the writer can produce, on the workflow that can produce
 * it: a non-empty object holding a `workspace` or exact `base-head`
 * comparison, and/or unique canonical nominations within admission's bound.
 */
export function decodeRunRecordReaderEvidenceRequest(
  value: unknown,
  workflow: unknown,
): RunRecordReaderEvidenceRequestV1 {
  if (workflow !== READER_EVIDENCE_WORKFLOW) fail("invalid");
  const root = kit.object(value);
  kit.exact(root, ["comparisonRequest", "readerSources"], ["comparisonRequest", "readerSources"]);
  if (root.comparisonRequest === undefined && root.readerSources === undefined) fail("invalid");
  const comparisonRequest =
    root.comparisonRequest === undefined ? undefined : decodeComparison(root.comparisonRequest);
  const readerSources =
    root.readerSources === undefined ? undefined : decodeSources(root.readerSources);
  return {
    ...(comparisonRequest ? { comparisonRequest } : {}),
    ...(readerSources ? { readerSources } : {}),
  };
}

function decodeComparison(value: unknown): ReaderComparisonRequestV1 {
  const comparison = kit.object(value);
  if (comparison.kind === "workspace") {
    kit.exact(comparison, ["kind"]);
    return { kind: "workspace" };
  }
  if (comparison.kind !== "base-head") fail("invalid");
  kit.exact(comparison, ["kind", "baseRevision", "headRevision"]);
  return {
    kind: "base-head",
    baseRevision: kit.revision(comparison.baseRevision),
    headRevision: kit.revision(comparison.headRevision),
  };
}

function decodeSources(value: unknown): ReaderSourceHintV1[] {
  const items = kit.array(value);
  // The catalog value, not limit(): the entry has no override, so the two are
  // equal, and a stored record decodes the same on every host.
  if (items.length === 0 || items.length > limitDefinition(READER_SOURCE_NOMINATIONS_LIMIT).value) {
    fail("invalid");
  }
  const sources = items.map((item) => {
    try {
      return parseReaderSourceHintV1(item as ReaderSourceHintV1);
    } catch {
      // The hint parser's own refusal names admission codes; this field has one.
      return fail("invalid");
    }
  });
  if (new Set(sources.map(({ role, path }) => `${role}\0${path}`)).size !== sources.length) {
    fail("invalid");
  }
  return sources.map(({ role, path }) => ({ role, path }));
}
