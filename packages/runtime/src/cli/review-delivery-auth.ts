// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { glabEnvironment } from "../delivery/gitlab-adapter.js";
import {
  ExecFileReadOnlyCommandRunner,
  type ReadOnlyCommandRunner,
} from "../delivery/preflight.js";
import { decodeReviewTargetV2, type ReviewTargetV2 } from "../review/contracts.js";
import { isDnsHostname } from "../shared/dns-hostname.js";
import type { GithubReviewFetchPort } from "../review-delivery/providers/github.js";
import type {
  GitLabReviewHttpRequest,
  GitLabReviewHttpTransport,
} from "../review-delivery/providers/gitlab.js";

export interface LocalReviewDeliveryAuthPorts {
  readonly kind: "github";
  readonly github: {
    readonly authorization: () => string | null;
    readonly fetch: GithubReviewFetchPort;
  };
}

export interface LocalGitLabReviewDeliveryAuthPorts {
  readonly kind: "gitlab";
  readonly gitlab: {
    readonly host: string;
    readonly transport: GitLabReviewHttpTransport;
  };
}

export type LocalReviewDeliveryAuthErrorCode =
  | "authentication-unavailable"
  | "invalid-target-host"
  | "invalid-request-path";

export class LocalReviewDeliveryAuthOperatorError extends Error {
  public constructor(
    public readonly code: LocalReviewDeliveryAuthErrorCode,
    message: string,
    public readonly nextAction: string,
  ) {
    super(message);
    this.name = "LocalReviewDeliveryAuthOperatorError";
  }
}

function authFailure(
  provider: "github" | "gitlab",
  host: string,
): LocalReviewDeliveryAuthOperatorError {
  const command =
    provider === "github"
      ? "gh auth login --hostname github.com"
      : `glab auth login --hostname ${host}`;
  return new LocalReviewDeliveryAuthOperatorError(
    "authentication-unavailable",
    `${provider === "github" ? "GitHub" : "GitLab"} review authentication is unavailable for ${host}. Run ${command} and retry.`,
    command,
  );
}

function safeToken(value: string): string | null {
  const token = value.trim();
  return token.length > 0 && !/\s/u.test(token) ? token : null;
}

function ghEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    TMPDIR: source.TMPDIR,
    XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
    GH_CONFIG_DIR: source.GH_CONFIG_DIR,
    GH_TOKEN: source.GH_TOKEN,
    GITHUB_TOKEN: source.GITHUB_TOKEN,
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
  };
  return Object.fromEntries(Object.entries(selected).filter((entry) => entry[1] !== undefined));
}

function selectedPath(path: string, origin: string): URL {
  if (
    !path.startsWith("/api/v4/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("#")
  ) {
    throw new LocalReviewDeliveryAuthOperatorError(
      "invalid-request-path",
      "The provider request path is outside the selected GitLab HTTPS origin.",
      "Correct the selected provider request path and retry.",
    );
  }
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname !== path.split("?")[0]) {
    throw new LocalReviewDeliveryAuthOperatorError(
      "invalid-request-path",
      "The provider request path is outside the selected GitLab HTTPS origin.",
      "Correct the selected provider request path and retry.",
    );
  }
  return url;
}

/** Resolve one selected CLI credential; never expose command output in failures. */
export async function loadLocalReviewDeliveryAuthPorts(input: {
  readonly target: ReviewTargetV2;
  readonly cwd: string;
  readonly commands?: ReadOnlyCommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: GithubReviewFetchPort;
}): Promise<LocalReviewDeliveryAuthPorts | LocalGitLabReviewDeliveryAuthPorts> {
  const target = decodeReviewTargetV2(input.target);
  if (!isDnsHostname(target.host, { anyCase: true, singleLabel: true })) {
    throw new LocalReviewDeliveryAuthOperatorError(
      "invalid-target-host",
      "The selected review target host must be a bare DNS hostname.",
      "Correct the review target hostname and retry.",
    );
  }
  const commands = input.commands ?? new ExecFileReadOnlyCommandRunner();
  const environment = input.environment ?? process.env;
  if (target.scmProvider === "github") {
    const result = await commands
      .run("gh", ["auth", "token", "--hostname", target.host], input.cwd, {
        env: ghEnvironment(environment),
      })
      .catch(() => null);
    const token =
      result?.exitCode === 0 && result.failure === undefined ? safeToken(result.stdout) : null;
    if (token === null) throw authFailure("github", target.host);
    return {
      kind: "github",
      github: { authorization: () => `Bearer ${token}`, fetch: input.fetch ?? globalThis.fetch },
    };
  }

  const result = await commands
    .run("glab", ["config", "get", "token", "--host", target.host], input.cwd, {
      env: glabEnvironment(environment),
    })
    .catch(() => null);
  const token =
    result?.exitCode === 0 && result.failure === undefined ? safeToken(result.stdout) : null;
  if (token === null) throw authFailure("gitlab", target.host);
  const origin = new URL(`https://${target.host}`).origin;
  const fetch = input.fetch ?? globalThis.fetch;
  const transport: GitLabReviewHttpTransport = {
    async request(request: GitLabReviewHttpRequest) {
      const url = selectedPath(request.path, origin);
      const response = await fetch(url.href, {
        method: request.method,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(request.bodyBytes === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(request.bodyBytes === undefined ? {} : { body: Buffer.from(request.bodyBytes) }),
      });
      const text = await response.text();
      let body: unknown = text.length === 0 ? null : text;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          // A non-JSON redirect/error body still reaches the provider with its actual status.
        }
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        redirected: response.redirected,
      };
    },
  };
  return { kind: "gitlab", gitlab: { host: target.host, transport } };
}
