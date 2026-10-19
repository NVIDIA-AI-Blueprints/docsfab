// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { fixture } from "./fixtures/review-delivery/presentation/synthetic.js";
import { createReviewDeliveryPlan } from "../src/review-delivery/plan.js";
import { createGithubReviewAdapter } from "../src/review-delivery/providers/github.js";
import { GitLabReviewDeliveryProvider } from "../src/review-delivery/providers/gitlab.js";
import { loadLocalReviewDeliveryAuthPorts } from "../src/cli/review-delivery-auth.js";
import { formatFreshGitLabReviewPreview } from "../src/cli/review-delivery.js";
import type { ReadOnlyCommandRunner } from "../src/delivery/preflight.js";

const TOKEN = "synthetic-review-token";
const CWD = "/synthetic/review";
const CONTEXT = {
  kind: "docsfab-review-delivery-effect-context" as const,
  schemaVersion: 1 as const,
  logicalDeliveryId: "review:7",
  correlationSeed: Buffer.from("synthetic-local-auth").toString("base64url"),
  committedEffects: [],
};

function commands(result = { exitCode: 0, stdout: `${TOKEN}\n`, stderr: "" }) {
  const calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const runner: ReadOnlyCommandRunner = {
    async run(command, args, cwd, options) {
      expect(cwd).toBe(CWD);
      calls.push({ command, args, env: options?.env });
      return result;
    },
  };
  return { runner, calls };
}

function plan(provider: "github" | "gitlab") {
  const input = fixture(provider, "addition", { sameRepository: true });
  return {
    input,
    plan: createReviewDeliveryPlan({
      ...input,
      ...(provider === "gitlab"
        ? {
            actor: { host: input.capabilities.host, id: "42" },
            requestedActions: "overview" as const,
          }
        : { requestedActions: "overview" as const }),
    }),
  };
}

describe("CLI-local review delivery authentication", () => {
  it("renders retained plan data with credential redaction and inert controls", () => {
    const { plan: selectedPlan } = plan("gitlab");
    if (!selectedPlan.findings[0]) throw new Error("Synthetic plan requires a finding.");
    const rendered = formatFreshGitLabReviewPreview({
      ...selectedPlan,
      findings: selectedPlan.findings.map((finding, index) =>
        index === 0
          ? {
              ...finding,
              path: "README.md\n\u001b[31m\u202e\u200b",
              text: "Authorization: Bearer synthetic-preview-token\nReview text\u001b[31m\u009b\u061c",
            }
          : finding,
      ),
      actions: selectedPlan.actions.map((action) =>
        action.kind === "publish-inline"
          ? { ...action, anchor: { ...action.anchor, path: "README.md\n\u001b[31m" } }
          : action,
      ),
      limitations: ["unsupported\n\u001b[31m"],
    });
    expect(rendered).toContain("publish-summary");
    expect(rendered).toContain("publish-inline");
    expect(rendered).toContain("[REDACTED_CREDENTIAL]");
    expect(rendered).toContain("Plan limitation:");
    expect(rendered).toContain("\\n\\u001b");
    expect(rendered).toContain("\\u{9b}");
    expect(rendered).toContain("\\u{202e}");
    expect(rendered).toContain("\\u{200b}");
    expect(rendered).toContain("\\u{61c}");
    expect(rendered).not.toContain("synthetic-preview-token");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u009b");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).not.toContain("\u200b");
    expect(rendered).not.toContain("\u061c");
    expect(rendered).not.toContain("README.md\n");
  });

  it("selects only gh for a GitHub target and supplies the real provider with a private bearer credential", async () => {
    const { runner, calls } = commands();
    const { input, plan: selectedPlan } = plan("github");
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return Response.json({ message: "unavailable" }, { status: 401 });
    });
    const ports = await loadLocalReviewDeliveryAuthPorts({
      target: selectedPlan.target,
      cwd: CWD,
      commands: runner,
      environment: {
        PATH: "/synthetic/bin",
        GH_TOKEN: "selected-cli-token",
        GITLAB_TOKEN: "not-selected",
      },
      fetch,
    });
    expect(ports.kind).toBe("github");
    if (ports.kind !== "github") return;
    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["gh", ["auth", "token", "--hostname", "github.com"]],
    ]);
    expect(calls[0]?.env?.GH_TOKEN).toBe("selected-cli-token");
    expect(calls[0]?.env?.GITLAB_TOKEN).toBeUndefined();
    expect(JSON.stringify(ports)).not.toContain(TOKEN);
    const provider = createGithubReviewAdapter({
      plan: selectedPlan,
      snapshot: input.snapshot,
      ...ports.github,
    });
    await provider.prepareNextEffect({
      plan: selectedPlan,
      priorObservations: [],
      context: CONTEXT,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toMatch(/^https:\/\/api\.github\.com\//u);
    expect(fetchCalls[0]?.init.redirect).toBe("manual");
    expect(new Headers(fetchCalls[0]?.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("selects only glab for a GitLab target and pins native fetch to its HTTPS origin", async () => {
    const { runner, calls } = commands();
    const { plan: selectedPlan } = plan("gitlab");
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response("<html>redirect</html>", {
        status: 302,
        headers: { Location: "https://elsewhere.test" },
      });
    });
    const ports = await loadLocalReviewDeliveryAuthPorts({
      target: selectedPlan.target,
      cwd: CWD,
      commands: runner,
      environment: { PATH: "/synthetic/bin", GITLAB_TOKEN: "inherited-global" },
      fetch,
    });
    expect(ports.kind).toBe("gitlab");
    if (ports.kind !== "gitlab") return;
    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["glab", ["config", "get", "token", "--host", "gitlab.example.com"]],
    ]);
    expect(calls[0]?.env?.GITLAB_TOKEN).toBe("inherited-global");
    expect(JSON.stringify(ports)).not.toContain(TOKEN);
    const provider = new GitLabReviewDeliveryProvider(ports.gitlab.host, ports.gitlab.transport);
    const prepared = await provider.prepareNextEffect({
      plan: selectedPlan,
      priorObservations: [],
      context: CONTEXT,
    });
    expect(prepared.kind).not.toBe("effect");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://gitlab.example.com/api/v4/user");
    expect(fetchCalls[0]?.init.redirect).toBe("manual");
    expect(new Headers(fetchCalls[0]?.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const response = await ports.gitlab.transport.request({ method: "GET", path: "/api/v4/user" });
    expect(response).toMatchObject({
      status: 302,
      body: "<html>redirect</html>",
      redirected: false,
    });
    expect(response.headers.location).toBe("https://elsewhere.test");
    await expect(
      ports.gitlab.transport.request({ method: "GET", path: "//elsewhere.test/api/v4/user" }),
    ).rejects.toThrow("selected GitLab HTTPS origin");
    await expect(
      ports.gitlab.transport.request({ method: "GET", path: "/api/v4/../user" }),
    ).rejects.toThrow("selected GitLab HTTPS origin");
    expect(fetchCalls).toHaveLength(2);
  });

  it.each(["github", "gitlab"] as const)("sanitizes missing %s CLI auth", async (provider) => {
    const { runner } = commands({ exitCode: 1, stdout: TOKEN, stderr: TOKEN });
    const { plan: selectedPlan } = plan(provider);
    const fetch = vi.fn();
    const action = loadLocalReviewDeliveryAuthPorts({
      target: selectedPlan.target,
      cwd: CWD,
      commands: runner,
      fetch,
    });
    await expect(action).rejects.toThrow(
      provider === "github" ? "gh auth login" : "glab auth login",
    );
    await expect(action).rejects.not.toThrow(TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["github", "gitlab"] as const)(
    "sanitizes thrown %s command failures",
    async (provider) => {
      const { plan: selectedPlan } = plan(provider);
      const runner: ReadOnlyCommandRunner = {
        async run() {
          throw new Error(TOKEN);
        },
      };
      const action = loadLocalReviewDeliveryAuthPorts({
        target: selectedPlan.target,
        cwd: CWD,
        commands: runner,
      });
      await expect(action).rejects.toThrow(
        provider === "github" ? "gh auth login" : "glab auth login",
      );
      await expect(action).rejects.not.toThrow(TOKEN);
    },
  );

  it("passes GitLab method, bytes, status, headers, and redirect state without replay", async () => {
    const { plan: selectedPlan } = plan("gitlab");
    const { runner } = commands();
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ id: 88 }, { status: 201, headers: { "X-Request-Id": "synthetic-request" } }),
    );
    const ports = await loadLocalReviewDeliveryAuthPorts({
      target: selectedPlan.target,
      cwd: CWD,
      commands: runner,
      fetch,
    });
    expect(ports.kind).toBe("gitlab");
    if (ports.kind !== "gitlab") return;
    const bodyBytes = new TextEncoder().encode('{"body":"review"}');
    const reply = await ports.gitlab.transport.request({
      method: "POST",
      path: "/api/v4/projects/42/merge_requests/7/notes",
      bodyBytes,
    });
    expect(reply).toMatchObject({
      status: 201,
      body: { id: 88 },
      redirected: false,
      headers: { "x-request-id": "synthetic-request" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(Buffer.from(init.body as Buffer)).toEqual(Buffer.from(bodyBytes));
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
});
