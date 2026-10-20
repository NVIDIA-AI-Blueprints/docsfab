// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadSavedRunPublicationDecodeOptions,
  publishInvocationDecodeOptions,
} from "../src/cli/run/editorial-replay.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

describe("saved-run publication decode options", () => {
  it("derives no options for a run id that would leave the run store (#2366)", async () => {
    const root = await roots.create("docsfab-publication-options-");
    const stateDirectory = join(root, "runs");
    await mkdir(stateDirectory, { recursive: true });
    // A record that decodes and needs options, bound to the id it is looked up by.
    const planted = (id: string): string =>
      `${JSON.stringify({
        schemaVersion: 2,
        id,
        workflow: "update-documentation",
        status: "succeeded",
        repository: { sourcePath: root, revision: "0".repeat(40) },
        steps: [],
        workflowBranchCoverage: {},
      })}\n`;
    const unsafeId = "x/../../outside";
    // `<runs>/x/../../outside.json` resolves to this record, outside the run store.
    await writeFile(join(root, "outside.json"), planted(unsafeId));
    await writeFile(join(stateDirectory, "inside.json"), planted("inside"));
    // Positive control: the same record under a safe id inside the store yields options.
    expect(
      (await loadSavedRunPublicationDecodeOptions(stateDirectory, "inside"))
        ?.decodeWorkflowBranchCoverage,
    ).toBeTypeOf("function");
    // The unsafe id reaches no record, even one that would decode.
    expect(await loadSavedRunPublicationDecodeOptions(stateDirectory, unsafeId)).toBeUndefined();
    expect(
      await publishInvocationDecodeOptions([unsafeId, "--draft-mr"], stateDirectory),
    ).toBeUndefined();
    // A run with no record is left to the publication path's refusal.
    expect(
      await loadSavedRunPublicationDecodeOptions(stateDirectory, "missing-run"),
    ).toBeUndefined();
  });
});
