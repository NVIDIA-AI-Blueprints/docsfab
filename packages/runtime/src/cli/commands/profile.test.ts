// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { handleProfileCommand } from "./profile.js";

describe("profile command", () => {
  it("includes seed among required subcommands", async () => {
    await expect(handleProfileCommand([])).rejects.toThrow(/"seed".*"probe".*"draft"/u);
  });
});
