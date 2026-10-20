// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Publish and resume exactly one draft-MR delivery from a `docsfab-roadmap::managed`
 * issue cycle.
 *
 * Adds no publication or write-authorization mechanism of its own: the bounded
 * cycle's confirmation and write gates run through `runManagedIssueCycleOnce`,
 * and the injected host publisher owns the credential-bearing GitLab boundary.
 * This orchestrator sees only credential-free records.
 *
 * The delivery receipt store makes branch/commit/push/MR effects idempotent;
 * the per-cycle publish record lets a re-run adopt the prior draft MR. An
 * interrupted publish records the preserved patch, next action, and recovery
 * command without advancing the managed issue past in-review.
 */

import {
  reconcileManagedCycleDraftMrLink,
  runManagedIssueCycleOnce,
  type ManagedCycleDeliveryLinkV1,
  type ManagedCycleLinkV1,
  type ManagedCycleOnceHost,
  type ManagedCycleOnceOutcomeV1,
  type ManagedIssueCycleOnceInputV1,
} from "./managed-cycle.js";
import type { AutoCycleOnceRecordV1 } from "./once.js";
import type { LocalUserGitLabPublicationResultV1 } from "../delivery/publication-result.js";

export const MANAGED_CYCLE_PUBLISH_SCHEMA_VERSION = 1 as const;

export type ManagedCyclePublishStatus = "opened" | "deferred" | "no-op";

export type ManagedCyclePublishErrorCode = "duplicate-merge-request" | "publish-boundary-mismatch";

export class ManagedCyclePublishError extends Error {
  public constructor(public readonly code: ManagedCyclePublishErrorCode) {
    super(`Managed-cycle draft-MR publication rejected the resume for the stated reason: ${code}.`);
    this.name = "ManagedCyclePublishError";
  }
}

function fail(code: ManagedCyclePublishErrorCode): never {
  throw new ManagedCyclePublishError(code);
}

/**
 * Terminal outcome of one publish attempt. `deferred` is a fail-closed
 * interruption that preserved the patch and left a credential-free recovery
 * command.
 */
export type ManagedCyclePublishAttemptV1 =
  | { status: "opened"; result: LocalUserGitLabPublicationResultV1 }
  | {
      status: "deferred";
      failureCode: string;
      lastConfirmedState: string;
      nextAction: string;
      recoveryCommand: string;
      patchPreserved: true;
    };

export interface ManagedCyclePublishRecordV1 {
  schemaVersion: 1;
  kind: "docsfab-managed-cycle-publish-record";
  cycleId: string;
  issueIid: number;
  linkSha256: string;
  status: ManagedCyclePublishStatus;
  delivery: ManagedCycleDeliveryLinkV1 | null;
  mergeRequest: { iid: number; url: string } | null;
  lifecycleTarget: ManagedCycleLinkV1["lifecycleTarget"];
  failureCode: string | null;
  nextAction: string | null;
  recoveryCommand: string | null;
  patchEvidencePreserved: boolean;
}

export interface ManagedCyclePublishHost extends ManagedCycleOnceHost {
  /** A `resume` call must adopt the prior branch/commit/push/MR, not duplicate them. */
  publish(input: {
    link: ManagedCycleLinkV1;
    record: AutoCycleOnceRecordV1;
    resume: boolean;
  }): Promise<ManagedCyclePublishAttemptV1>;
  loadPublishRecord(cycleId: string): Promise<ManagedCyclePublishRecordV1 | null>;
  savePublishRecord(record: ManagedCyclePublishRecordV1): Promise<void>;
}

export interface ManagedCyclePublishOutcomeV1 {
  cycle: ManagedCycleOnceOutcomeV1;
  publish: ManagedCyclePublishRecordV1 | null;
}

/**
 * Without a ready issue or a publication-eligible GitLab write, nothing is
 * published and the source checkout is untouched.
 */
export async function runManagedCyclePublishOnce(
  input: ManagedIssueCycleOnceInputV1,
  host: ManagedCyclePublishHost,
): Promise<ManagedCyclePublishOutcomeV1> {
  const cycleId = input.selection.cycleId;
  const prior = await host.loadPublishRecord(cycleId);
  const cycle = await runManagedIssueCycleOnce(input, host);
  const link = cycle.link;

  if (link === null || cycle.once === null) {
    return { cycle, publish: null };
  }

  // Persist the patch-preserving no-op so a resume is stable.
  if (link.draftMrLink === null) {
    const record = noOpRecord(link);
    await host.savePublishRecord(record);
    host.log?.(
      `managed publish: issue ${link.issueIid}; ${link.disposition}; ` +
        `no draft MR (${link.lifecycleTarget}); patch preserved.`,
    );
    return { cycle, publish: record };
  }

  const resume = prior !== null && prior.linkSha256 === link.linkSha256;
  const attempt = await host.publish({
    link,
    record: cycle.once.record,
    resume,
  });

  if (attempt.status === "deferred") {
    const record = deferredRecord(link, attempt);
    await host.savePublishRecord(record);
    host.log?.(
      `managed publish: issue ${link.issueIid}; interrupted (${attempt.failureCode}); ` +
        `next ${attempt.nextAction}; patch preserved; re-run to resume.`,
    );
    return { cycle, publish: record };
  }

  // Fails closed on branch drift, so the link targets the authorized branch.
  const delivery = reconcileManagedCycleDraftMrLink(link, attempt.result);
  if (
    resume &&
    prior.mergeRequest !== null &&
    prior.mergeRequest.iid !== delivery.mergeRequestIid
  ) {
    // A resumed cycle observed a different MR than the one it already opened:
    // fail closed rather than record two draft MRs for one managed issue.
    fail("duplicate-merge-request");
  }
  if (attempt.result.mergeRequest.iid !== delivery.mergeRequestIid) {
    fail("publish-boundary-mismatch");
  }
  const record = openedRecord(link, delivery, attempt.result);
  await host.savePublishRecord(record);
  host.log?.(
    `managed publish: issue ${link.issueIid}; draft MR ` +
      `!${delivery.mergeRequestIid} ${attempt.result.mergeRequest.url}; ` +
      `${resume ? "reused" : "opened"}; lifecycle in-review.`,
  );
  return { cycle, publish: record };
}

function noOpRecord(link: ManagedCycleLinkV1): ManagedCyclePublishRecordV1 {
  return {
    schemaVersion: MANAGED_CYCLE_PUBLISH_SCHEMA_VERSION,
    kind: "docsfab-managed-cycle-publish-record",
    cycleId: link.cycleId,
    issueIid: link.issueIid,
    linkSha256: link.linkSha256,
    status: "no-op",
    delivery: null,
    mergeRequest: null,
    lifecycleTarget: link.lifecycleTarget,
    failureCode: null,
    nextAction: null,
    recoveryCommand: null,
    patchEvidencePreserved: link.patchEvidencePreserved,
  };
}

function deferredRecord(
  link: ManagedCycleLinkV1,
  attempt: Extract<ManagedCyclePublishAttemptV1, { status: "deferred" }>,
): ManagedCyclePublishRecordV1 {
  return {
    schemaVersion: MANAGED_CYCLE_PUBLISH_SCHEMA_VERSION,
    kind: "docsfab-managed-cycle-publish-record",
    cycleId: link.cycleId,
    issueIid: link.issueIid,
    linkSha256: link.linkSha256,
    status: "deferred",
    delivery: null,
    mergeRequest: null,
    lifecycleTarget: link.lifecycleTarget,
    failureCode: attempt.failureCode,
    nextAction: attempt.nextAction,
    recoveryCommand: attempt.recoveryCommand,
    patchEvidencePreserved: true,
  };
}

function openedRecord(
  link: ManagedCycleLinkV1,
  delivery: ManagedCycleDeliveryLinkV1,
  result: LocalUserGitLabPublicationResultV1,
): ManagedCyclePublishRecordV1 {
  return {
    schemaVersion: MANAGED_CYCLE_PUBLISH_SCHEMA_VERSION,
    kind: "docsfab-managed-cycle-publish-record",
    cycleId: link.cycleId,
    issueIid: link.issueIid,
    linkSha256: link.linkSha256,
    status: "opened",
    delivery,
    mergeRequest: { iid: delivery.mergeRequestIid, url: result.mergeRequest.url },
    lifecycleTarget: delivery.lifecycleTarget,
    failureCode: null,
    nextAction: null,
    recoveryCommand: null,
    patchEvidencePreserved: true,
  };
}
