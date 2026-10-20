// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  formatSetupBootstrapResult,
  formatSetupBootstrapResultDetailed,
  setupBootstrapPresentation,
  type SetupBootstrapResult,
} from "../src/setup/bootstrap.js";
import {
  formatDocsFabInitPlan,
  formatInitResult,
  initPlanPresentation,
  initResultPresentation,
} from "../src/init/render.js";
import type { DocsFabInitPlan } from "../src/init/types.js";

const planDigest = "b".repeat(64);

function setupResult(overrides: Partial<SetupBootstrapResult> = {}): SetupBootstrapResult {
  return {
    schemaVersion: 1,
    kind: "docsfab-setup-bootstrap",
    status: "ready",
    configurationRoot: "/private/config",
    layout: "split",
    hostConfigPath: "/private/config/host.yaml",
    secretsPath: "/private/config/secrets.env",
    envPath: "/private/config/.env",
    activePolicyProfile: "profiles/current.yaml",
    activeExecutionProfile: "nvidia-inference-gpt-6-sol-pi",
    requiredSecretNames: ["MODEL_API_KEY"],
    seeded: true,
    migrated: false,
    credentialSource: "ambient",
    profile: {
      providerId: "nvidia-inference-api",
      modelId: "azure/openai/gpt-6-sol",
      transport: "openai-chat-completions",
      endpointUrl: "https://api.example.test/v1",
      requestUrl: "https://api.example.test/v1/chat/completions",
      configuredContextWindow: 524_288,
      effectiveContextWindow: 524_288,
      effectiveLimitReason: "none",
    },
    nextCommand: "docsfab doctor",
    explanation: "The current host profile is configured.",
    ...overrides,
  };
}

function initPlan(overrides: Partial<DocsFabInitPlan> = {}): DocsFabInitPlan {
  return {
    schemaVersion: 1,
    kind: "docsfab-init-plan",
    sha256: planDigest,
    projectConfig: {
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
    },
    change: "create",
    repository: "detected",
    repositoryBindingSha256: "c".repeat(64),
    configPreimageSha256: "d".repeat(64),
    gitignore: {
      path: ".gitignore",
      action: "create",
      missingEntries: [".docsfab/", ".docsfab-init.*"],
      preimageSha256: "f".repeat(64),
      maxBytes: 262_144,
      maxBytesSource: "config/limits.yaml",
    },
    changedPaths: [".docsfab.json", ".gitignore"],
    gitlabAuthentication: "missing",
    gitlabProject: "ready",
    gitlabBindingSha256: "e".repeat(64),
    providerConfiguration: "partial",
    profileStatus: "unknown",
    privateRoots: ["runs", "evidence", "delivery", "receipts"],
    doctor: "profile-diagnostics-required",
    nextActions: ["glab-auth-login", "profile-inspect"],
    ...overrides,
  };
}

describe("shared setup and init presentation", () => {
  it("uses one setup projection for compact and detailed views without repeating probes", () => {
    const result = setupResult();
    const compact = formatSetupBootstrapResult(result);
    const detailed = formatSetupBootstrapResultDetailed(result);
    expect(compact).toContain("DocsFab setup complete");
    expect(compact).toContain("Status: Ready");
    expect(compact).toContain("API key: Saved in /private/config/secrets.env (value hidden)");
    expect(compact).toContain("Connection check: Not run");
    expect(compact).toContain("Next step: docsfab doctor");
    expect(compact).not.toContain("Layout: split");
    expect(compact).not.toContain("The current host profile is configured.");
    expect(detailed).toContain("Layout: split");
    expect(detailed).toContain("Active policy profile: profiles/current.yaml");
    expect(detailed).toContain("The current host profile is configured.");
    expect(setupBootstrapPresentation(result)).toEqual(
      setupBootstrapPresentation(result, { detail: "normal" }),
    );
  });

  it("keeps missing model choices and credential requirements prominent", () => {
    const result = setupResult({
      status: "blocked-model-choice-required",
      credentialSource: "none",
      profile: undefined,
      requiredSecretNames: ["MODEL_API_KEY"],
      nextCommand: "docsfab setup --profile <compositionId>",
    });
    const output = formatSetupBootstrapResult(result);
    expect(output).toContain("Setup needs attention: Model choice required.");
    expect(output).toContain("API key: Missing");
    expect(output).toContain("Required action:");
    expect(output).toContain("choose a provider");
    expect(output).toContain("Next step: docsfab setup --profile <compositionId>");
  });

  it("shows every proposed init file effect and binds approval to the exact digest", () => {
    const plan = initPlan();
    const output = formatDocsFabInitPlan(plan);
    expect(output).toContain("File effect: .docsfab.json");
    expect(output).toContain("File effect: .gitignore");
    expect(output).toContain("Private .gitignore: create");
    expect(output).toContain(`Plan digest: ${plan.sha256}`);
    expect(output).toContain(
      `Approve only these proposed effects for exact plan digest ${plan.sha256}?`,
    );
    expect(output).toContain("Cancel: Default");
    expect(output).toContain("GitLab authentication is missing");
    expect(output).toContain(
      "Private roots: runs, evidence, delivery, receipts are user-private; paths withheld",
    );
    expect(output.indexOf("File effect: .docsfab.json")).toBeLessThan(
      output.indexOf("Approve only these proposed effects"),
    );
    expect(output).not.toContain("repository path");
    expect(output).toContain("same repository context");
    expect(output).toContain("same --repo and --remote selections");
    expect(output).toContain(`--approve-plan-sha256 ${plan.sha256}`);
    expect(output).not.toContain("/work/repo");
    expect(initPlanPresentation(plan)).toEqual(initPlanPresentation(plan));
  });

  it("preserves init no-change effects, uncertain writes, and next actions", () => {
    const noChange = initPlan({
      change: "none",
      changedPaths: [],
      gitignore: {
        ...initPlan().gitignore,
        action: "none",
        missingEntries: [],
      },
      gitlabAuthentication: "configured",
      providerConfiguration: "ready",
      doctor: "ready",
      nextActions: [],
    });
    const preview = formatDocsFabInitPlan(noChange);
    expect(preview).toContain("already current; initialization will not rewrite .docsfab.json");
    expect(preview).toContain("File effects: none");
    expect(preview).toContain("Private .gitignore: none");

    const result = {
      status: "applied-cleanup-required",
      mutation: "applied" as const,
      changedPaths: [".docsfab.json"],
      uncertainPaths: [".gitignore"],
      nextActions: ["glab-auth-login", "profile-inspect"] as const,
      gitignore: { status: "unknown" as const, added: [], reason: "readback-unavailable" as const },
    };
    const output = formatInitResult(result);
    expect(output).toContain("Initialization applied");
    expect(output).toContain("Changed files: .docsfab.json");
    expect(output).toContain("File state uncertain: .gitignore");
    expect(output).toContain("ATTENTION:");
    expect(output).toContain("Next action:");
    expect(output).toContain("glab auth login");
    expect(initResultPresentation(result)).toEqual(initResultPresentation(result));
  });
});
