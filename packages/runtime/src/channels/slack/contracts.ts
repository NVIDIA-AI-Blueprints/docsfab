// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed-schema Slack outbound notify contracts.
 *
 * Host-emitted only. Incoming-webhook secrets stay in the host post closure;
 * the runtime WeakMap stores only that function. The model never receives
 * Slack tools. The safe-label body is clamped to the safe-label ceiling. When
 * the caller supplies the status-block projector string, that string is `text`
 * (CLI `--quiet` words, no ANSI, no second dialect).
 */

import { createContractKit, type ContractFail } from "../../contract-kit/index.js";
import type { RunStatus } from "../../records/contracts.js";
import { ExternalInputContractError } from "../../inputs/contracts.js";
import { sanitizeExternalInputMetadata } from "../../inputs/disclosure.js";
import { fail, type SlackNotifyErrorCode } from "./transport.js";

export { SlackNotifyError, fail, type SlackNotifyErrorCode } from "./transport.js";

export const SLACK_RUN_NOTIFICATION_SCHEMA_VERSION = 1 as const;
export const SLACK_BOT_TOKEN_ENV = "DOCSFAB_SLACK_BOT_TOKEN" as const;

export const SLACK_RUN_STATUSES = [
  "queued",
  "running",
  "needs-input",
  "needs-human-decision",
  "succeeded",
  "failed",
] as const satisfies readonly RunStatus[];
export type SlackRunStatus = (typeof SLACK_RUN_STATUSES)[number];

type _SlackRunStatusExhaustive = Exclude<RunStatus, SlackRunStatus> extends never ? true : never;
const _slackRunStatusExhaustive: _SlackRunStatusExhaustive = true;
void _slackRunStatusExhaustive;

export const SLACK_NOTIFIABLE_RUN_STATUSES = [
  "succeeded",
  "failed",
  "needs-human-decision",
] as const satisfies readonly SlackRunStatus[];
export type SlackNotifiableRunStatus = (typeof SLACK_NOTIFIABLE_RUN_STATUSES)[number];

export const SLACK_NOTIFY_EVENTS = ["terminal-disposition", "needs-human-decision"] as const;
export type SlackNotifyEvent = (typeof SLACK_NOTIFY_EVENTS)[number];

export const SLACK_NOTIFY_SKIP_REASONS = ["not-notifiable", "no-transport"] as const;
export type SlackNotifySkipReason = (typeof SLACK_NOTIFY_SKIP_REASONS)[number];

export const kit = createContractKit({
  fail: fail as ContractFail<SlackNotifyErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_LABEL_MAX = 120;
const ANSI_SHAPE = /\u001b\[/u;
const GITLAB_ORIGIN_ENV = "DOCSFAB_SLACK_GITLAB_ORIGIN";
const WEB_URL_SHAPE = /https?:\/\/[^\s<>"'`]+/giu;
const WEB_URL_SCHEME_SHAPE = /https?:\/\//giu;
const PROJECTED_HOST_PATH_SHAPE =
  /(?:^|[\s`'"])(?:\/(?:Users|home|root|private|tmp|var)\/|[A-Za-z]:\\)/u;

export interface SlackRunCompletionInputV1 {
  runId: string;
  /** Content-free locator such as `docsfab-run-record:<runId>`; never a host path. */
  recordLocator: string;
  runStatus: SlackRunStatus;
  /** Optional catalog workflow name or other safe label; clamped. */
  workflowSafeLabel?: string;
  /**
   * Optional status-block projector output. When set, becomes `text`;
   * omitting it keeps the safe-label body. The caller projects; Slack does not
   * walk a RunRecord or invent status tokens.
   */
  statusBlock?: string;
}

export interface SlackRunNotificationV1 {
  schemaVersion: 1;
  kind: "docsfab-slack-run-notification";
  event: SlackNotifyEvent;
  runId: string;
  recordLocator: string;
  runStatus: SlackNotifiableRunStatus;
  workflowSafeLabel: string | null;
  disclosureLevel: "safe-label";
  text: string;
  notificationSha256: string;
}

export interface SlackIncomingWebhookBodyV1 {
  readonly text: string;
}

export type SlackNotifyResultV1 =
  | { status: "posted"; notification: SlackRunNotificationV1 }
  | { status: "skipped"; reason: SlackNotifySkipReason };

export function isSlackNotifiableRunStatus(status: string): status is SlackNotifiableRunStatus {
  return (SLACK_NOTIFIABLE_RUN_STATUSES as readonly string[]).includes(status);
}

export function contentFreeRunRecordLocator(runId: string): string {
  return `docsfab-run-record:${runIdForNotify(runId)}`;
}

export function eventForNotifiableStatus(status: SlackNotifiableRunStatus): SlackNotifyEvent {
  return status === "needs-human-decision" ? "needs-human-decision" : "terminal-disposition";
}

export function buildSlackRunNotification(
  input: SlackRunCompletionInputV1,
  environment: NodeJS.Dict<string> = process.env,
): SlackRunNotificationV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const allowedGitLabOrigin = configuredGitLabOrigin(environment);
  const root = kit.object(input);
  kit.exact(
    root,
    ["runId", "recordLocator", "runStatus", "workflowSafeLabel", "statusBlock"],
    ["workflowSafeLabel", "statusBlock"],
  );
  const runStatus = kit.enumeration(root.runStatus, SLACK_NOTIFIABLE_RUN_STATUSES);
  const runId = runIdForNotify(root.runId);
  const recordLocator = recordLocatorForNotify(root.recordLocator);
  const workflowSafeLabel =
    root.workflowSafeLabel === undefined
      ? null
      : safeLabel(root.workflowSafeLabel, allowedGitLabOrigin);
  const event = eventForNotifiableStatus(runStatus);
  const statusBlock =
    root.statusBlock === undefined
      ? undefined
      : requireProjectedStatusBlock(root.statusBlock, allowedGitLabOrigin);
  const text =
    statusBlock === undefined
      ? composeNotifyText({ runStatus, runId, recordLocator, workflowSafeLabel })
      : statusBlock;
  if (statusBlock === undefined) {
    assertSafeLabelCeiling(text, allowedGitLabOrigin);
  }
  kit.rejectCredentials({ text });
  return kit.seal("docsfab-slack-run-notification", "notificationSha256", {
    event,
    runId,
    recordLocator,
    runStatus,
    workflowSafeLabel,
    disclosureLevel: "safe-label" as const,
    text,
  });
}

export function slackIncomingWebhookBody(
  notification: SlackRunNotificationV1,
): SlackIncomingWebhookBodyV1 {
  return kit.deepFreeze({ text: notification.text });
}

function runIdForNotify(value: unknown): string {
  const result = kit.string(value);
  if (!SAFE_RUN_ID.test(result)) fail("invalid-value");
  assertSafeLabelCeiling(result, null);
  return result;
}

function recordLocatorForNotify(value: unknown): string {
  const result = kit.identifier(value);
  assertSafeLabelCeiling(result, null);
  return result;
}

function safeLabel(value: unknown, allowedGitLabOrigin: string | null): string {
  const raw = kit.string(value);
  assertSafeLabelCeiling(raw, allowedGitLabOrigin);
  let cleaned: string;
  try {
    cleaned = sanitizeExternalInputMetadata(raw);
  } catch (error) {
    if (error instanceof ExternalInputContractError && error.code === "credential-material") {
      fail("credential-material");
    }
    fail("invalid-value");
  }
  if (cleaned.length === 0) fail("invalid-value");
  assertSafeLabelCeiling(cleaned, allowedGitLabOrigin);
  kit.rejectCredentials({ workflowSafeLabel: cleaned });
  return cleaned.length > SAFE_LABEL_MAX ? `${cleaned.slice(0, SAFE_LABEL_MAX - 3)}...` : cleaned;
}

function requireProjectedStatusBlock(value: unknown, allowedGitLabOrigin: string | null): string {
  const text = kit.string(value);
  if (text.length === 0) fail("invalid-value");
  assertProjectedStatusBlockText(text, allowedGitLabOrigin);
  kit.rejectCredentials({ text });
  return text;
}

function assertProjectedStatusBlockText(value: string, allowedGitLabOrigin: string | null): void {
  if (
    ANSI_SHAPE.test(value) ||
    PROJECTED_HOST_PATH_SHAPE.test(value) ||
    /hooks\.slack\.com/iu.test(value)
  ) {
    fail("invalid-value");
  }
  assertAllowedWebUrls(value, allowedGitLabOrigin);
}

function composeNotifyText(input: {
  runStatus: SlackNotifiableRunStatus;
  runId: string;
  recordLocator: string;
  workflowSafeLabel: string | null;
}): string {
  const lines = [
    `DocsFab run ${input.runStatus}`,
    `run: ${input.runId}`,
    `record: ${input.recordLocator}`,
  ];
  if (input.workflowSafeLabel !== null) lines.push(`workflow: ${input.workflowSafeLabel}`);
  return lines.join("\n");
}

/** Channel posts allow only configured-origin GitLab URLs and safe labels. */
function assertSafeLabelCeiling(value: string, allowedGitLabOrigin: string | null): void {
  if (/hooks\.slack\.com/iu.test(value) || /(?:^|[\\/])(?:Users|home|root)[\\/]/u.test(value)) {
    fail("invalid-value");
  }
  assertAllowedWebUrls(value, allowedGitLabOrigin);
}

function configuredGitLabOrigin(environment: NodeJS.Dict<string>): string | null {
  const value = environment[GITLAB_ORIGIN_ENV];
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 2_048) fail("invalid-value");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid-value");
  }
  if (parsed.username !== "" || parsed.password !== "") fail("credential-material");
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    fail("invalid-value");
  }
  const origin = normalizedOrigin(parsed);
  if (origin === "https://hooks.slack.com") fail("invalid-value");
  return origin;
}

function assertAllowedWebUrls(value: string, allowedGitLabOrigin: string | null): void {
  const matches = [...value.matchAll(WEB_URL_SHAPE)];
  if ([...value.matchAll(WEB_URL_SCHEME_SHAPE)].length !== matches.length) fail("invalid-value");
  if (/https?:\/\//iu.test(value.replace(WEB_URL_SHAPE, ""))) fail("invalid-value");
  for (const match of matches) {
    let parsed: URL;
    try {
      parsed = new URL(match[0]);
    } catch {
      fail("invalid-value");
    }
    if (parsed.username !== "" || parsed.password !== "") fail("credential-material");
    if (
      parsed.protocol !== "https:" ||
      allowedGitLabOrigin === null ||
      normalizedOrigin(parsed) !== allowedGitLabOrigin
    ) {
      fail("invalid-value");
    }
  }
}

function normalizedOrigin(parsed: URL): string {
  const hostname = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
  if (hostname === "") fail("invalid-value");
  return `${parsed.protocol}//${hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}`;
}
