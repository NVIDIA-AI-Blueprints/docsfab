// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleProfileCommand } from "../src/cli/commands/profile.js";
import { ModelProfileApprovalError } from "../src/model/profile-approval.js";
import {
  InvalidModelProfileConfigurationError,
  ModelProfileMigrationError,
  UnsupportedModelProfileApiFormatError,
} from "../src/model/configuration.js";
import {
  ProfileApplyError,
  ProfileOwnerArtifactOperatorError,
} from "../src/model/profile-apply/types.js";
import {
  loadProfileApprovalEndpoint,
  readOwnerHostFile,
} from "../src/model/profile-apply/observe.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { validModelEnvironment } from "./helpers.js";

function expectNoCommandLoop(nextAction: string | undefined, command: string): void {
  expect(nextAction).toBeDefined();
  expect(nextAction).not.toMatch(new RegExp(`docsfab profile ${command}(?![\\w-])`, "u"));
}

async function profileFailure(argv: string[]) {
  const error = await handleProfileCommand(argv).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(Error);
  return toOperatorErrorEnvelope(error);
}

describe("profile command failure routing (#1094)", () => {
  it.each([
    ["inspect", ["inspect", "--unknown"]],
    ["inspect", ["inspect", "--json", "--verbose"]],
    ["approve", ["approve", "--unknown"]],
    ["approve", ["approve", "--resolve-conflict", "made-up"]],
    ["approve", ["approve", "--apply"]],
    ["approve", ["approve"]],
    ["rollback", ["rollback"]],
    ["seed", ["seed", "--preset", ""]],
    ["probe", ["probe"]],
    ["draft", ["draft"]],
  ] as const)("does not send a %s argument failure back to itself", async (command, argv) => {
    const envelope = await profileFailure([...argv]);
    expect(envelope.code).toBe("cli-usage");
    expectNoCommandLoop(envelope.nextAction, command);
  });

  it("routes an inspect configuration failure to correction and doctor", async () => {
    for (const [key, value] of Object.entries({
      ...validModelEnvironment,
      MODEL_BASE_URL: "bad-base-url-canary",
    })) {
      vi.stubEnv(key, value);
    }
    try {
      const envelope = await profileFailure(["inspect"]);
      expect(envelope.code).toBe("invalid-model-profile-configuration");
      expect(envelope.message).toContain("MODEL_BASE_URL");
      expect(envelope.message).not.toContain("bad-base-url-canary");
      expect(envelope.nextAction).toContain("MODEL_BASE_URL");
      expect(envelope.nextAction).toContain("docsfab doctor");
      expectNoCommandLoop(envelope.nextAction, "inspect");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["API format", "MODEL_API_FORMAT", "unsupported", "unsupported-model-profile-api-format"],
    ["base URL", "MODEL_BASE_URL", "bad-base-url-canary", "invalid-model-profile-configuration"],
  ] as const)(
    "routes an invalid owner %s during approval without printing its value",
    async (_, key, value, code) => {
      const root = await realpath(
        await mkdtemp(resolve(tmpdir(), "docsfab-profile-approval-route-")),
      );
      try {
        await chmod(root, 0o700);
        const environment = { ...validModelEnvironment, [key]: value };
        await writeFile(
          resolve(root, ".env"),
          `${Object.entries(environment)
            .map(([name, configured]) => `${name}=${configured}`)
            .join("\n")}\n`,
          { mode: 0o600 },
        );
        const error = await loadProfileApprovalEndpoint({
          projectRoot: root,
          purpose: "policy",
          ambientEnvironment: {},
        }).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(Error);
        const envelope = toOperatorErrorEnvelope(error);
        expect(envelope.code).toBe(code);
        expect(envelope.message).not.toContain(value);
        expect(envelope.nextAction).toContain(key);
        expectNoCommandLoop(envelope.nextAction, "approve");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not send a missing seed choice back to profile seed", async () => {
    const envelope = await profileFailure(["seed"]);
    expect(envelope.code).toBe("profile-seed-choice-required");
    expectNoCommandLoop(envelope.nextAction, "seed");
    expect(envelope.nextAction).toContain("docsfab setup");
  });

  it("routes an unreadable model profile artifact to owner-controlled repair", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-profile-missing-key-")));
    try {
      await chmod(root, 0o700);
      const environment = { ...validModelEnvironment };
      delete (environment as Partial<typeof validModelEnvironment>).MODEL_API_KEY;
      await writeFile(
        resolve(root, ".env"),
        `${Object.entries(environment)
          .map(([name, configured]) => `${name}=${configured}`)
          .join("\n")}\n`,
        { mode: 0o600 },
      );
      const error = await loadProfileApprovalEndpoint({
        projectRoot: root,
        purpose: "policy",
        ambientEnvironment: {},
      }).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(ProfileApplyError);
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.code).toBe("profile-owner-artifact-rejected");
      expect(envelope.nextAction).toContain("DocsFab configuration root");
      expect(envelope.nextAction).not.toContain("docsfab doctor");
      expectNoCommandLoop(envelope.nextAction, "approve");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("names the unreadable approval artifact and avoids unrelated doctor guidance", async () => {
    const root = await realpath(
      await mkdtemp(resolve(tmpdir(), "docsfab-profile-owner-artifact-")),
    );
    const publicKey = resolve(root, "authority.pub");
    try {
      await chmod(root, 0o700);
      await writeFile(publicKey, "public-key", { mode: 0o644 });
      const error = await readOwnerHostFile(publicKey, "public signing key").then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(ProfileApplyError);
      const envelope = toOperatorErrorEnvelope(error);
      expect(envelope.code).toBe("profile-owner-artifact-rejected");
      expect(envelope.message).toContain("public signing key");
      expect(envelope.nextAction).toContain("authority's intended public signing key");
      expect(envelope.nextAction).not.toContain("docsfab doctor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes every approval rejection away from the failed subcommand", () => {
    const approval = toOperatorErrorEnvelope(new ModelProfileApprovalError());
    expect(approval.code).toBe("invalid-model-profile-approval");
    expectNoCommandLoop(approval.nextAction, "approve");
    expect(approval.nextAction).toContain("docsfab profile inspect --catalog --json");

    const apply = toOperatorErrorEnvelope(new ProfileApplyError());
    expect(apply.code).toBe("profile-apply-rejected");
    for (const command of ["approve", "rollback", "seed"]) {
      expectNoCommandLoop(apply.nextAction, command);
    }
  });

  it("routes owner evidence artifacts to cause-specific, content-safe repair", () => {
    const artifact = toOperatorErrorEnvelope(
      new ProfileOwnerArtifactOperatorError("saved approval bundle"),
    );
    expect(artifact.code).toBe("profile-owner-artifact-rejected");
    expect(artifact.message).toContain("saved approval bundle");
    expect(artifact.nextAction).toContain("exact saved approval bundle");
    expect(artifact.nextAction).not.toContain("docsfab doctor");
    expect(artifact.message).not.toContain("/tmp");
  });

  it("names invalid profile settings and confirms corrections through doctor", () => {
    const migration = new ModelProfileMigrationError([
      {
        profile: "MODEL",
        field: "MODEL_BASE_URL",
        message: "invalid endpoint",
      },
    ]);
    const envelope = toOperatorErrorEnvelope(migration);
    expect(envelope.code).toBe("migration-required");
    expect(envelope.nextAction).toContain("docsfab doctor");
    expectNoCommandLoop(envelope.nextAction, "inspect");
    expect(formatOperatorErrorEnvelope(envelope)).toContain(envelope.nextAction!);

    const approval = toOperatorErrorEnvelope(
      new InvalidModelProfileConfigurationError([
        { profile: "JUDGE", field: "JUDGE_BASE_URL", message: "invalid endpoint" },
      ]),
    );
    expect(approval.code).toBe("invalid-model-profile-configuration");
    expect(approval.message).toContain("JUDGE_BASE_URL");
    expect(approval.message).not.toContain("invalid endpoint");
    expect(approval.nextAction).toContain("docsfab doctor");
    expectNoCommandLoop(approval.nextAction, "approve");
  });

  it.each([
    ["policy", "MODEL_API_FORMAT"],
    ["judge", "JUDGE_API_FORMAT"],
  ] as const)("routes unsupported %s API format through its named setting", (purpose, field) => {
    const envelope = toOperatorErrorEnvelope(new UnsupportedModelProfileApiFormatError(purpose));
    expect(envelope.code).toBe("unsupported-model-profile-api-format");
    expect(envelope.message).toContain(field);
    expect(envelope.nextAction).toContain("docsfab doctor");
    expectNoCommandLoop(envelope.nextAction, "approve");
  });
});
