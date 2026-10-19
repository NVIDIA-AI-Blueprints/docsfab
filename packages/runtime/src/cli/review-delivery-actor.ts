// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { decodeReviewTargetV2, type ReviewTargetV2 } from "../review/contracts.js";
import type { ReviewDeliveryActor } from "../review-delivery/contracts.js";
import type {
  LocalGitLabReviewDeliveryAuthPorts,
  LocalReviewDeliveryAuthPorts,
} from "./review-delivery-auth.js";

export type LocalGitLabReviewActorErrorCode =
  | "invalid-target"
  | "wrong-provider"
  | "host-mismatch"
  | "unavailable"
  | "rate-limited"
  | "invalid-response";

/** An operator-facing refusal without transport errors, response bodies, or credentials. */
export class LocalGitLabReviewActorOperatorError extends Error {
  public constructor(
    public readonly code: LocalGitLabReviewActorErrorCode,
    message: string,
    public readonly nextAction: string,
  ) {
    super(message);
    this.name = "LocalGitLabReviewActorOperatorError";
  }
}

function refusal(code: LocalGitLabReviewActorErrorCode): LocalGitLabReviewActorOperatorError {
  switch (code) {
    case "invalid-target":
      return new LocalGitLabReviewActorOperatorError(
        code,
        "The selected review target is invalid.",
        "Resolve the GitLab review target again and retry.",
      );
    case "wrong-provider":
      return new LocalGitLabReviewActorOperatorError(
        code,
        "GitLab review actor observation requires a GitLab target and authentication.",
        "Select a GitLab review target and its local GitLab authentication.",
      );
    case "host-mismatch":
      return new LocalGitLabReviewActorOperatorError(
        code,
        "The authenticated GitLab host differs from the selected review target.",
        "Authenticate for the selected GitLab host and retry.",
      );
    case "rate-limited":
      return new LocalGitLabReviewActorOperatorError(
        code,
        "GitLab could not identify the current actor because the host is rate limited.",
        "Wait for the GitLab rate limit to clear, then retry.",
      );
    case "invalid-response":
      return new LocalGitLabReviewActorOperatorError(
        code,
        "GitLab returned an invalid current-user identity.",
        "Check the selected GitLab host and authentication, then retry.",
      );
    case "unavailable":
      return new LocalGitLabReviewActorOperatorError(
        code,
        "GitLab current-user observation is unavailable.",
        "Check the selected GitLab host and authentication, then retry.",
      );
  }
}

/** Observe the current account through the already-selected, authenticated GitLab transport. */
export async function observeLocalGitLabReviewActor(input: {
  readonly target: ReviewTargetV2;
  readonly auth: LocalReviewDeliveryAuthPorts | LocalGitLabReviewDeliveryAuthPorts;
}): Promise<ReviewDeliveryActor> {
  let target: ReviewTargetV2;
  try {
    target = decodeReviewTargetV2(input.target);
  } catch {
    throw refusal("invalid-target");
  }
  if (target.scmProvider !== "gitlab" || input.auth.kind !== "gitlab")
    throw refusal("wrong-provider");
  if (input.auth.gitlab.host !== target.host) throw refusal("host-mismatch");

  let response;
  try {
    response = await input.auth.gitlab.transport.request({ method: "GET", path: "/api/v4/user" });
  } catch {
    throw refusal("unavailable");
  }
  if (
    typeof response.status !== "number" ||
    !Number.isInteger(response.status) ||
    response.redirected === true ||
    (response.status >= 300 && response.status < 400)
  )
    throw refusal("unavailable");
  if (response.status === 429) throw refusal("rate-limited");
  if (response.status < 200 || response.status >= 300) throw refusal("unavailable");

  const body = response.body;
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw refusal("invalid-response");
  const id = (body as Record<string, unknown>).id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
    throw refusal("invalid-response");
  return { host: target.host, id: String(id) };
}
