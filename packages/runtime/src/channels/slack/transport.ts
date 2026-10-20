// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime Slack notification port. WeakMap stores only the post function;
 * host closures hold webhook secrets and never copy them onto the transport.
 *
 * This module stays free of runtime value imports so the host can load it
 * under Node strip-types.
 */

export type SlackNotifyErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "transport-required"
  | "transport-failed"
  | "migration-required";

export class SlackNotifyError extends Error {
  readonly code: SlackNotifyErrorCode;

  constructor(code: SlackNotifyErrorCode) {
    super(`Slack notify rejected: ${code}.`);
    this.name = "SlackNotifyError";
    this.code = code;
  }
}

export function fail(code: SlackNotifyErrorCode): never {
  throw new SlackNotifyError(code);
}

export const SLACK_NOTIFICATION_TRANSPORT_KIND = "docsfab-slack-notification-transport" as const;

export interface SlackNotificationTransport {
  readonly kind: typeof SLACK_NOTIFICATION_TRANSPORT_KIND;
}

interface IncomingWebhookBody {
  readonly text: string;
}

interface TransportState {
  post(body: IncomingWebhookBody): Promise<void>;
}

const transports = new WeakMap<object, TransportState>();

export interface FakeSlackNotificationTransport {
  readonly transport: SlackNotificationTransport;
  readonly posts: IncomingWebhookBody[];
}

export function createFakeSlackNotificationTransport(): FakeSlackNotificationTransport {
  const posts: IncomingWebhookBody[] = [];
  const transport = Object.freeze({ kind: SLACK_NOTIFICATION_TRANSPORT_KIND });
  transports.set(transport, {
    async post(body) {
      posts.push(Object.freeze({ text: body.text }));
    },
  });
  return { transport, posts };
}

export function createHostSlackNotificationTransport(
  post: (body: IncomingWebhookBody) => Promise<void>,
): SlackNotificationTransport {
  if (typeof post !== "function") fail("invalid-value");
  const transport = Object.freeze({ kind: SLACK_NOTIFICATION_TRANSPORT_KIND });
  transports.set(transport, { post });
  return transport;
}

export async function deliverSlackNotification(
  transport: SlackNotificationTransport,
  body: IncomingWebhookBody,
): Promise<void> {
  const poster = transports.get(transport as object);
  if (!poster || transport.kind !== SLACK_NOTIFICATION_TRANSPORT_KIND) {
    fail("transport-required");
  }
  await poster.post(body);
}
