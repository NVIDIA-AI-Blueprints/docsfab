// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { observeLocalGitLabReviewActor } from "../src/cli/review-delivery-actor.js";
import type {
  LocalGitLabReviewDeliveryAuthPorts,
  LocalReviewDeliveryAuthPorts,
} from "../src/cli/review-delivery-auth.js";
import type {
  GitLabReviewHttpRequest,
  GitLabReviewHttpResponse,
} from "../src/review-delivery/providers/gitlab.js";
import { createReviewTargetV2 } from "../src/review/target-migration.js";
import { fixture } from "./fixtures/review-delivery/presentation/synthetic.js";

const selectedFixture = fixture("gitlab", "addition", { sameRepository: true });
const target = selectedFixture.target;
const githubTarget = fixture("github", "addition", { sameRepository: true }).target;
const SECRET = "synthetic-forge-secret";

function selected(
  response: GitLabReviewHttpResponse | (() => Promise<GitLabReviewHttpResponse>),
  host = target.host,
) {
  const calls: GitLabReviewHttpRequest[] = [];
  const auth: LocalGitLabReviewDeliveryAuthPorts = {
    kind: "gitlab",
    gitlab: {
      host,
      transport: {
        async request(request) {
          calls.push(request);
          return typeof response === "function" ? response() : response;
        },
      },
    },
  };
  return { auth, calls };
}

const reply = (body: unknown, status = 200): GitLabReviewHttpResponse => ({
  status,
  headers: {},
  body,
});

describe("selected GitLab review actor observation", () => {
  it("returns the authenticated numeric actor through one selected-host GET", async () => {
    const { auth, calls } = selected(reply({ id: 42 }));
    await expect(observeLocalGitLabReviewActor({ target, auth })).resolves.toEqual({
      host: target.host,
      id: "42",
    });
    expect(calls).toEqual([{ method: "GET", path: "/api/v4/user" }]);
  });

  it("observes a changed account afresh instead of deriving it from request identity", async () => {
    let actorId = 42;
    const { auth, calls } = selected(async () => reply({ id: actorId }));
    expect((await observeLocalGitLabReviewActor({ target, auth })).id).toBe("42");
    actorId = 99;
    const {
      schemaVersion: _schemaVersion,
      kind: _kind,
      targetSha256: _digest,
      ...targetInput
    } = target;
    const replacedRequest = createReviewTargetV2(
      { ...targetInput, requestIdentitySha256: "a".repeat(64) },
      selectedFixture.source,
    );
    expect(replacedRequest.targetSha256).not.toBe(target.targetSha256);
    expect((await observeLocalGitLabReviewActor({ target: replacedRequest, auth })).id).toBe("99");
    expect(calls).toEqual([
      { method: "GET", path: "/api/v4/user" },
      { method: "GET", path: "/api/v4/user" },
    ]);
  });

  it("refuses wrong provider and host before transport", async () => {
    const selectedPorts = selected(reply({ id: 42 }));
    const wrongHost = selected(reply({ id: 42 }), "elsewhere.example.test");
    const githubAuth: LocalReviewDeliveryAuthPorts = {
      kind: "github",
      github: { authorization: () => null, fetch: async () => Response.json({}) },
    };
    await expect(
      observeLocalGitLabReviewActor({ target: githubTarget, auth: selectedPorts.auth }),
    ).rejects.toMatchObject({ code: "wrong-provider" });
    await expect(observeLocalGitLabReviewActor({ target, auth: githubAuth })).rejects.toMatchObject(
      {
        code: "wrong-provider",
      },
    );
    await expect(
      observeLocalGitLabReviewActor({ target, auth: wrongHost.auth }),
    ).rejects.toMatchObject({
      code: "host-mismatch",
    });
    expect(selectedPorts.calls).toEqual([]);
    expect(wrongHost.calls).toEqual([]);
  });

  it.each([
    ["redirected", { ...reply({ id: 42 }), redirected: true }, "unavailable"],
    ["3xx", reply({ id: 42 }, 302), "unavailable"],
    ["unauthorized", reply({ id: 42 }, 401), "unavailable"],
    ["rate-limited", reply({ id: 42 }, 429), "rate-limited"],
    ["server error", reply({ id: 42 }, 503), "unavailable"],
    ["malformed status", { ...reply({ id: 42 }), status: "200" }, "unavailable"],
  ] as const)("refuses %s without replay", async (_name, response, code) => {
    const { auth, calls } = selected(response as GitLabReviewHttpResponse);
    await expect(observeLocalGitLabReviewActor({ target, auth })).rejects.toMatchObject({ code });
    expect(calls).toEqual([{ method: "GET", path: "/api/v4/user" }]);
  });

  it.each([
    null,
    [],
    "not-json",
    {},
    { id: "42" },
    { id: 0 },
    { id: -1 },
    { id: 1.5 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses malformed or non-numeric actor body %j", async (body) => {
    const { auth, calls } = selected(reply(body));
    await expect(observeLocalGitLabReviewActor({ target, auth })).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(calls).toHaveLength(1);
  });

  it("sanitizes transport failures and raw response bodies", async () => {
    const thrown = selected(async () => {
      throw new Error(SECRET);
    });
    const badBody = selected(reply({ id: SECRET, body: SECRET }));
    for (const sample of [thrown, badBody]) {
      let reported: unknown;
      try {
        await observeLocalGitLabReviewActor({ target, auth: sample.auth });
      } catch (error) {
        reported = error;
      }
      expect(reported).toBeInstanceOf(Error);
      expect(String(reported)).not.toContain(SECRET);
      expect(JSON.stringify(reported)).not.toContain(SECRET);
      expect(sample.calls).toEqual([{ method: "GET", path: "/api/v4/user" }]);
    }
  });
});
