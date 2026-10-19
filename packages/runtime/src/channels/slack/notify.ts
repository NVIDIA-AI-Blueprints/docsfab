// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host Slack notifier. The transport WeakMap stores only the post function;
 * webhook secrets stay in the host closure that minted the transport. They are
 * never copied onto transport objects, notification payloads, or model-facing
 * surfaces.
 */

import {
  SLACK_RUN_STATUSES,
  buildSlackRunNotification,
  isSlackNotifiableRunStatus,
  kit,
  slackIncomingWebhookBody,
  type SlackNotifyResultV1,
  type SlackRunCompletionInputV1,
} from "./contracts.js";
import { deliverSlackNotification, type SlackNotificationTransport } from "./transport.js";

/**
 * Host completion hook. Call after a run reaches a durable status.
 * Non-notifiable statuses and a missing transport skip without posting.
 */
export async function notifySlackRunCompletion(
  input: SlackRunCompletionInputV1,
  transport: SlackNotificationTransport | null | undefined,
): Promise<SlackNotifyResultV1> {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const root = kit.object(input);
  kit.exact(
    root,
    ["runId", "recordLocator", "runStatus", "workflowSafeLabel", "statusBlock"],
    ["workflowSafeLabel", "statusBlock"],
  );
  const runStatus = kit.enumeration(root.runStatus, SLACK_RUN_STATUSES);
  if (!isSlackNotifiableRunStatus(runStatus)) {
    return { status: "skipped", reason: "not-notifiable" };
  }
  if (transport == null) {
    return { status: "skipped", reason: "no-transport" };
  }
  const notification = buildSlackRunNotification({
    runId: input.runId,
    recordLocator: input.recordLocator,
    runStatus,
    ...(input.workflowSafeLabel !== undefined
      ? { workflowSafeLabel: input.workflowSafeLabel }
      : {}),
    ...(input.statusBlock !== undefined ? { statusBlock: input.statusBlock } : {}),
  });
  const body = slackIncomingWebhookBody(notification);
  await deliverSlackNotification(transport, body);
  return { status: "posted", notification };
}
