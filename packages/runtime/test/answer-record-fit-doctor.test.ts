// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadContentFreeFitSettings } from "../src/cli/commands/answer-record-fit-doctor.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

describe("credential-free records fit settings", () => {
  it("accepts a split host configuration without a secrets file", async () => {
    const configurationRoot = await roots.create("docsfab-record-fit-split-config-");
    await mkdir(configurationRoot, { recursive: true });
    await writeFile(join(configurationRoot, "host.yaml"), "{}\n", "utf8");

    const settings = await loadContentFreeFitSettings({
      DOCSFAB_CONFIG_ROOT: configurationRoot,
    });

    expect(settings).toMatchObject({ DOCSFAB_CONFIG_ROOT: configurationRoot });
    expect(settings.MODEL_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(settings.DOCSFAB_ANSWER_SUBMISSION).toBeUndefined();
  });
});
