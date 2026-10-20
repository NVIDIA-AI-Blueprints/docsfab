// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const runSetupBootstrap = vi.hoisted(() => vi.fn());

vi.mock("../../setup/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../setup/bootstrap.js")>();
  return {
    ...actual,
    runSetupBootstrap,
  };
});

import { rejectedModelApiFormatMessage } from "../../config/profile-projection.js";
import type { SetupBootstrapResult } from "../../setup/bootstrap.js";
import { handleSetupCommand } from "./setup.js";

const ready: SetupBootstrapResult = {
  schemaVersion: 1,
  kind: "docsfab-setup-bootstrap",
  status: "ready",
  configurationRoot: "/private/host/docsfab",
  layout: "split",
  envPath: "/private/host/docsfab/.env",
  seeded: false,
  migrated: false,
  credentialSource: "ambient",
  nextCommand: "docsfab doctor --repo /absolute/path/to/target-repo",
  explanation: "The host policy profile is ready.",
};

describe("setup command MODEL_API_FORMAT", () => {
  afterEach(() => {
    runSetupBootstrap.mockReset();
    process.exitCode = undefined;
    delete process.env.MODEL_API_FORMAT;
    vi.restoreAllMocks();
  });

  it("rejects a value that is neither a profile format nor a composition transport", async () => {
    process.env.MODEL_API_FORMAT = "openai-completions";
    await expect(handleSetupCommand([])).rejects.toThrow(
      rejectedModelApiFormatMessage("openai-completions"),
    );
    expect(runSetupBootstrap).not.toHaveBeenCalled();
  });

  it("derives MODEL_API_FORMAT from a composition transport before bootstrap", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.MODEL_API_FORMAT = "openai-chat-completions";
    runSetupBootstrap.mockResolvedValue(ready);
    await handleSetupCommand(["--json"]);
    expect(process.env.MODEL_API_FORMAT).toBe("chat_completions");
    expect(runSetupBootstrap).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
  });
});
