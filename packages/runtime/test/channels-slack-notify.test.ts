// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  SLACK_BOT_TOKEN_ENV,
  SLACK_NOTIFICATION_TRANSPORT_KIND,
  SlackNotifyError,
  buildSlackRunNotification,
  contentFreeRunRecordLocator,
  createFakeSlackNotificationTransport,
  createHostSlackNotificationTransport,
  isSlackNotifiableRunStatus,
  notifySlackRunCompletion,
  type SlackIncomingWebhookBodyV1,
  type SlackNotificationTransport,
} from "../src/channels/slack/index.js";
import type { ChangedFileEvidence } from "../src/impact/contracts.js";
import { projectStatusBlock } from "../src/operator/status-block.js";
import type { RunSummaryPublicationOutcome } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

const SLACK_TOKEN = `xoxb-${"1".repeat(12)}-${"A".repeat(20)}`;
// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest(SLACK_TOKEN);
const PLACEHOLDER_WEBHOOK =
  "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";
const GITLAB_ORIGIN_ENV = "DOCSFAB_SLACK_GITLAB_ORIGIN";

function gitLabEnvironment(origin: string): NodeJS.Dict<string> {
  return { [GITLAB_ORIGIN_ENV]: origin };
}

function terminalEvent(overrides: Record<string, string> = {}) {
  return {
    runId: "run-terminal-1",
    recordLocator: contentFreeRunRecordLocator("run-terminal-1"),
    runStatus: "succeeded" as const,
    workflowSafeLabel: "readiness",
    ...overrides,
  };
}

function decisionEvent(overrides: Record<string, string> = {}) {
  return {
    runId: "run-decision-1",
    recordLocator: contentFreeRunRecordLocator("run-decision-1"),
    runStatus: "needs-human-decision" as const,
    workflowSafeLabel: "ia-plan",
    ...overrides,
  };
}

function postedText(posts: SlackIncomingWebhookBodyV1[]): string {
  return JSON.stringify(posts);
}

const ANSI_SHAPE = /\u001b\[/u;
const HOST_PATH_SHAPE = /(?:^|[\s`'"])(?:\/(?:Users|home|root|private|tmp|var)\/|[A-Za-z]:\\)/u;

function minimalRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-test-001",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-10T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
    ...overrides,
  };
}

function recordWithChanges(
  files: ChangedFileEvidence[],
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return minimalRunRecord({
    changes: {
      files,
      patch: {
        sha256: "a".repeat(64),
        byteLength: 128,
        lineCount: 8,
        artifactPath: "/private/patches/run-test-001.patch",
        format: "git-diff",
      },
    },
    ...overrides,
  });
}

const FIXTURE_STATUS_BLOCK = {
  record: recordWithChanges([{ path: "docs/guide.md", status: "modified" }]),
  patchFileStats: [{ path: "docs/guide.md", insertions: 3, deletions: 1 }],
};

/**
 * CLI `--quiet` status projector words for FIXTURE_STATUS_BLOCK
 * (pipe, no ANSI). Slack must not fork this vocabulary.
 */
const QUIET_PROJECTOR_WORDS = [
  "VERDICT",
  "  review-documentation run-test",
  "    execution succeeded",
  "",
  "NEXT",
  "  docsfab runs show run-test-001 --json",
  "  Reason: Inspect the saved product evidence and review the local patch before deciding whether to publish.",
  "",
  "PATCH",
  "  docs/guide.md  +3/-1",
  "",
  "RECORD",
  "  run run-test-001",
].join("\n");

describe("channels Slack outbound notify", () => {
  it("posts a terminal disposition payload with run id and record locator", async () => {
    const fake = createFakeSlackNotificationTransport();
    const result = await notifySlackRunCompletion(terminalEvent(), fake.transport);
    expect(result.status).toBe("posted");
    if (result.status !== "posted") throw new Error("expected posted");
    expect(result.notification.event).toBe("terminal-disposition");
    expect(result.notification.runStatus).toBe("succeeded");
    expect(result.notification.runId).toBe("run-terminal-1");
    expect(result.notification.recordLocator).toBe("docsfab-run-record:run-terminal-1");
    expect(result.notification.disclosureLevel).toBe("safe-label");
    expect(result.notification.workflowSafeLabel).toBe("readiness");
    expect(result.notification.kind).toBe("docsfab-slack-run-notification");
    expect(fake.posts).toHaveLength(1);
    expect(Object.keys(fake.posts[0]!)).toEqual(["text"]);
    expect(fake.posts[0]!.text).toBe(
      [
        "DocsFab run succeeded",
        "run: run-terminal-1",
        "record: docsfab-run-record:run-terminal-1",
        "workflow: readiness",
      ].join("\n"),
    );
    expect(postedText(fake.posts)).not.toContain("xoxb-");
    expect(postedText(fake.posts)).not.toContain("hooks.slack.com");
    expect(JSON.stringify(result.notification)).not.toContain("xoxb-");
    expect(JSON.stringify(fake.transport)).not.toContain("xoxb-");
  });

  it("posts needs-human-decision with the same credential-free shape", async () => {
    const fake = createFakeSlackNotificationTransport();
    const result = await notifySlackRunCompletion(decisionEvent(), fake.transport);
    expect(result.status).toBe("posted");
    if (result.status !== "posted") throw new Error("expected posted");
    expect(result.notification.event).toBe("needs-human-decision");
    expect(result.notification.runStatus).toBe("needs-human-decision");
    expect(result.notification.runId).toBe("run-decision-1");
    expect(result.notification.recordLocator).toBe("docsfab-run-record:run-decision-1");
    expect(fake.posts[0]!.text).toContain("DocsFab run needs-human-decision");
    expect(fake.posts[0]!.text).toContain("run: run-decision-1");
    expect(fake.posts[0]!.text).toContain("record: docsfab-run-record:run-decision-1");
    expect(postedText(fake.posts)).not.toMatch(/xox[baprs]-/u);
    expect(Object.keys(fake.transport)).toEqual(["kind"]);
    expect(fake.transport.kind).toBe(SLACK_NOTIFICATION_TRANSPORT_KIND);
  });

  it("posts failed as a terminal disposition", async () => {
    const fake = createFakeSlackNotificationTransport();
    const result = await notifySlackRunCompletion(
      terminalEvent({ runStatus: "failed" }),
      fake.transport,
    );
    expect(result.status).toBe("posted");
    if (result.status !== "posted") throw new Error("expected posted");
    expect(result.notification.event).toBe("terminal-disposition");
    expect(result.notification.runStatus).toBe("failed");
    expect(fake.posts[0]!.text.startsWith("DocsFab run failed\n")).toBe(true);
  });

  it.each(["queued", "running", "needs-input"] as const)(
    "skips non-notifiable status %s",
    async (runStatus) => {
      const fake = createFakeSlackNotificationTransport();
      const result = await notifySlackRunCompletion(terminalEvent({ runStatus }), fake.transport);
      expect(result).toEqual({ status: "skipped", reason: "not-notifiable" });
      expect(fake.posts).toHaveLength(0);
      expect(isSlackNotifiableRunStatus(runStatus)).toBe(false);
    },
  );

  it("skips when the host has not configured a transport", async () => {
    const result = await notifySlackRunCompletion(terminalEvent(), null);
    expect(result).toEqual({ status: "skipped", reason: "no-transport" });
  });

  it("rejects a lookalike transport that is not host-minted", async () => {
    const lookalike = { kind: SLACK_NOTIFICATION_TRANSPORT_KIND } as SlackNotificationTransport;
    await expect(notifySlackRunCompletion(terminalEvent(), lookalike)).rejects.toMatchObject({
      name: "SlackNotifyError",
      code: "transport-required",
    });
  });

  it("rejects Slack tokens in the completion event", async () => {
    const fake = createFakeSlackNotificationTransport();
    await expect(
      notifySlackRunCompletion(terminalEvent({ workflowSafeLabel: SLACK_TOKEN }), fake.transport),
    ).rejects.toBeInstanceOf(SlackNotifyError);
    expect(fake.posts).toHaveLength(0);
  });

  it("rejects host paths and webhook URLs in the record locator", () => {
    expect(() =>
      buildSlackRunNotification(
        terminalEvent({ recordLocator: "/Users/operator/.docsfab/runs/run-terminal-1.json" }),
      ),
    ).toThrow(SlackNotifyError);
    expect(() =>
      buildSlackRunNotification(terminalEvent({ recordLocator: PLACEHOLDER_WEBHOOK })),
    ).toThrow(SlackNotifyError);
  });

  it("clamps workflow labels and refuses markdown or URLs", () => {
    const notification = buildSlackRunNotification(
      terminalEvent({ workflowSafeLabel: "  readiness <script> " }),
    );
    expect(notification.workflowSafeLabel).toBe("readiness script");
    expect(() =>
      buildSlackRunNotification(
        terminalEvent({ workflowSafeLabel: "https://example.invalid/run" }),
      ),
    ).toThrow(SlackNotifyError);
  });

  it("allows only URLs on the configured GitLab origin", () => {
    const statusBlock =
      "NEXT\n  https://GitLab.Example./group/project/-/merge_requests/1\n" +
      "  Reason: Draft MR is up.";
    const notification = buildSlackRunNotification(
      terminalEvent({ statusBlock }),
      gitLabEnvironment("https://gitlab.example"),
    );
    expect(notification.text).toBe(statusBlock);

    expect(() =>
      buildSlackRunNotification(
        terminalEvent({ statusBlock: "NEXT\n  https://other.example/group/project" }),
        gitLabEnvironment("https://gitlab.example"),
      ),
    ).toThrow(SlackNotifyError);
    expect(() =>
      buildSlackRunNotification(
        terminalEvent({ statusBlock: `NEXT\n  ${PLACEHOLDER_WEBHOOK}` }),
        gitLabEnvironment("https://hooks.slack.com"),
      ),
    ).toThrow(SlackNotifyError);
    for (const joined of [
      "https://gitlab.example/path)https://evil.example/path",
      "https://gitlab.example/path,https://evil.example/path",
    ]) {
      expect(() =>
        buildSlackRunNotification(
          terminalEvent({ statusBlock: `NEXT\n  ${joined}` }),
          gitLabEnvironment("https://gitlab.example"),
        ),
      ).toThrow(SlackNotifyError);
      expect(() =>
        buildSlackRunNotification(
          terminalEvent({ workflowSafeLabel: joined }),
          gitLabEnvironment("https://gitlab.example"),
        ),
      ).toThrow(SlackNotifyError);
    }
  });

  it("honours a different configured origin and then rejects the previous one", () => {
    const otherEnvironment = gitLabEnvironment("https://code.example.test");
    expect(
      buildSlackRunNotification(
        terminalEvent({ statusBlock: "NEXT\n  https://code.example.test/group/project" }),
        otherEnvironment,
      ).text,
    ).toContain("https://code.example.test/group/project");
    expect(() =>
      buildSlackRunNotification(
        terminalEvent({ statusBlock: "NEXT\n  https://gitlab.example/group/project" }),
        otherEnvironment,
      ),
    ).toThrow(SlackNotifyError);
  });

  it("applies the configured origin through the outbound notification hook", async () => {
    vi.stubEnv(GITLAB_ORIGIN_ENV, "https://gitlab.example");
    try {
      const fake = createFakeSlackNotificationTransport();
      const result = await notifySlackRunCompletion(
        terminalEvent({
          statusBlock: "NEXT\n  https://gitlab.example/group/project/-/merge_requests/1",
        }),
        fake.transport,
      );
      expect(result.status).toBe("posted");
      expect(fake.posts[0]!.text).toContain(
        "https://gitlab.example/group/project/-/merge_requests/1",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects URL credentials and preserves projected host-path rejection", () => {
    expect(() =>
      buildSlackRunNotification(
        terminalEvent({
          statusBlock: "NEXT\n  https://operator:secret@gitlab.example/group/project",
        }),
        gitLabEnvironment("https://gitlab.example"),
      ),
    ).toThrow(SlackNotifyError);
    expect(() =>
      buildSlackRunNotification(
        terminalEvent({ statusBlock: "NEXT\n  /home/operator/project" }),
        gitLabEnvironment("https://gitlab.example"),
      ),
    ).toThrow(SlackNotifyError);
  });

  it("posts through a host-supplied closure without enumerating it on the transport", async () => {
    const posts: SlackIncomingWebhookBodyV1[] = [];
    const transport = createHostSlackNotificationTransport(async (body) => {
      posts.push(body);
    });
    expect(Object.keys(transport)).toEqual(["kind"]);
    expect(JSON.stringify(transport)).not.toContain("hooks.slack.com");
    expect(JSON.stringify(transport)).not.toContain(PLACEHOLDER_WEBHOOK);
    const result = await notifySlackRunCompletion(terminalEvent(), transport);
    expect(result.status).toBe("posted");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("run: run-terminal-1");
    expect(JSON.stringify(posts)).not.toContain("hooks.slack.com");
  });

  it("names the reserved bot-token environment variable without reading it", () => {
    expect(SLACK_BOT_TOKEN_ENV).toBe("DOCSFAB_SLACK_BOT_TOKEN");
  });

  it("uses the same words as the #364 projector for one RunRecord (no ANSI)", async () => {
    const projected = projectStatusBlock(FIXTURE_STATUS_BLOCK);
    expect(projected).toBe(QUIET_PROJECTOR_WORDS);
    expect(projected).not.toMatch(ANSI_SHAPE);

    const notification = buildSlackRunNotification({
      runId: "run-test-001",
      recordLocator: contentFreeRunRecordLocator("run-test-001"),
      runStatus: "succeeded",
      statusBlock: projected,
    });
    expect(notification.text).toBe(projected);
    expect(notification.text).toBe(QUIET_PROJECTOR_WORDS);
    expect(notification.disclosureLevel).toBe("safe-label");
    expect(notification.recordLocator).toBe("docsfab-run-record:run-test-001");
    expect(notification.text.startsWith("DocsFab run succeeded")).toBe(false);

    const fake = createFakeSlackNotificationTransport();
    const result = await notifySlackRunCompletion(
      {
        runId: "run-test-001",
        recordLocator: contentFreeRunRecordLocator("run-test-001"),
        runStatus: "succeeded",
        statusBlock: projected,
      },
      fake.transport,
    );
    expect(result.status).toBe("posted");
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]!.text).toBe(QUIET_PROJECTOR_WORDS);
    expect(fake.posts[0]!.text).not.toMatch(ANSI_SHAPE);
    expect(postedText(fake.posts)).not.toContain("xoxb-");
    expect(postedText(fake.posts)).not.toContain("hooks.slack.com");
  });

  it("omits host paths and credentials from the projected Slack body", async () => {
    const projected = projectStatusBlock({
      record: recordWithChanges(
        [
          { path: "docs/guide.md", status: "modified" },
          { path: "/tmp/secret-host-copy.md", status: "modified" },
        ],
        {
          error: "Provider rejected api_key=nvapi-abcdefghijklmnopqrstuvwxyz012345",
        },
      ),
      patchFileStats: [
        { path: "docs/guide.md", insertions: 3, deletions: 1 },
        { path: "/tmp/secret-host-copy.md", insertions: 1, deletions: 0 },
      ],
    });
    const fake = createFakeSlackNotificationTransport();
    const result = await notifySlackRunCompletion(
      {
        runId: "run-test-001",
        recordLocator: contentFreeRunRecordLocator("run-test-001"),
        runStatus: "succeeded",
        statusBlock: projected,
      },
      fake.transport,
    );
    expect(result.status).toBe("posted");
    expect(fake.posts[0]!.text).not.toMatch(HOST_PATH_SHAPE);
    expect(fake.posts[0]!.text).not.toContain("/private/patches/");
    expect(fake.posts[0]!.text).not.toContain("/tmp/secret-host-copy.md");
    expect(fake.posts[0]!.text).not.toContain("nvapi-");
    expect(fake.posts[0]!.text).not.toContain("api_key=");
    expect(fake.posts[0]!.text).toContain("docs/guide.md  +3/-1");
    expect(fake.posts[0]!.text).toContain("RECORD");
    expect(fake.posts[0]!.text).toContain("run run-test-001");
  });

  it("keeps publication-succeeded NEXT as the merge-request URL", () => {
    const publication: RunSummaryPublicationOutcome = {
      status: "succeeded",
      mergeRequestUrl: "https://gitlab.example/group/project/-/merge_requests/1",
    };
    const projected = projectStatusBlock({
      record: recordWithChanges([{ path: "README.md", status: "modified" }]),
      publication,
    });
    const notification = buildSlackRunNotification(
      {
        runId: "run-test-001",
        recordLocator: contentFreeRunRecordLocator("run-test-001"),
        runStatus: "succeeded",
        statusBlock: projected,
      },
      gitLabEnvironment("https://gitlab.example"),
    );
    expect(notification.text).toMatch(/^VERDICT$/mu);
    expect(notification.text).toContain("https://gitlab.example/group/project/-/merge_requests/1");
    expect(notification.text).toContain("Draft MR is up.");
    expect(notification.text).not.toMatch(HOST_PATH_SHAPE);
    expect(notification.text).not.toMatch(ANSI_SHAPE);
  });

  it("rejects host paths and ANSI in a caller-supplied status block", () => {
    expect(() =>
      buildSlackRunNotification({
        runId: "run-test-001",
        recordLocator: contentFreeRunRecordLocator("run-test-001"),
        runStatus: "succeeded",
        statusBlock: "VERDICT\n/Users/operator/.docsfab/run.json",
      }),
    ).toThrow(SlackNotifyError);
    expect(() =>
      buildSlackRunNotification({
        runId: "run-test-001",
        recordLocator: contentFreeRunRecordLocator("run-test-001"),
        runStatus: "succeeded",
        statusBlock: "VERDICT\n\u001b[32msucceeded\u001b[0m",
      }),
    ).toThrow(SlackNotifyError);
  });

  it("still rejects credential material in mailbox fields when a status block is supplied", () => {
    expect(() =>
      buildSlackRunNotification({
        runId: "run-test-001",
        recordLocator: contentFreeRunRecordLocator("run-test-001"),
        runStatus: "succeeded",
        workflowSafeLabel: SLACK_TOKEN,
        statusBlock: QUIET_PROJECTOR_WORDS,
      }),
    ).toThrow(SlackNotifyError);
  });
});
