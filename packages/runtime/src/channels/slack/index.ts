// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  SLACK_BOT_TOKEN_ENV,
  SLACK_NOTIFIABLE_RUN_STATUSES,
  SLACK_NOTIFY_EVENTS,
  SLACK_NOTIFY_SKIP_REASONS,
  SLACK_RUN_NOTIFICATION_SCHEMA_VERSION,
  SLACK_RUN_STATUSES,
  SlackNotifyError,
  buildSlackRunNotification,
  contentFreeRunRecordLocator,
  eventForNotifiableStatus,
  isSlackNotifiableRunStatus,
  slackIncomingWebhookBody,
  type SlackIncomingWebhookBodyV1,
  type SlackNotifiableRunStatus,
  type SlackNotifyEvent,
  type SlackNotifyResultV1,
  type SlackNotifySkipReason,
  type SlackRunCompletionInputV1,
  type SlackRunNotificationV1,
  type SlackRunStatus,
} from "./contracts.js";
export { notifySlackRunCompletion } from "./notify.js";
export {
  SLACK_NOTIFICATION_TRANSPORT_KIND,
  createFakeSlackNotificationTransport,
  createHostSlackNotificationTransport,
  type FakeSlackNotificationTransport,
  type SlackNotificationTransport,
} from "./transport.js";
