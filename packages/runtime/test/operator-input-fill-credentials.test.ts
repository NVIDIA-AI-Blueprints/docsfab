// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bindOperatorInputFills } from "../src/inputs/operator-input-fill.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const WHEN = "2026-10-06T12:00:00.000Z";
const TEXT_SLOT = { inputId: "request", fillKind: "text" as const, label: "Request" };

/**
 * An operator's reply and attached files fill an InputAsk. Only DocsFab's own
 * configured credentials stop them; a credential shape is the operator's text
 * (#1807).
 */
describe("operator input fills and configured credentials", () => {
  const roots = temporaryRoots();

  it("withholds a reply that holds a configured credential, and binds a credential shape", async () => {
    const repositoryPath = await roots.create("docsfab-operator-input-reply-");
    const credential = configureCredential(["harbor", plantedCredentialValue(93, 24)].join("-"));
    await expect(
      bindOperatorInputFills({
        slots: [TEXT_SLOT],
        replyText: `Use ${credential} for the staging host.`,
        attachPaths: [],
        repositoryPath,
        when: WHEN,
      }),
    ).rejects.toThrow("The reply sentence contained a configured credential and was withheld.");

    const shaped = ["glpat", plantedCredentialValue(94, 20)].join("-");
    await expect(
      bindOperatorInputFills({
        slots: [TEXT_SLOT],
        replyText: `The old token ${shaped} was rotated.`,
        attachPaths: [],
        repositoryPath,
        when: WHEN,
      }),
    ).resolves.toEqual([expect.objectContaining({ inputId: "request", source: "reply-text" })]);
  });

  it("withholds an attached file that holds a configured credential, and binds a credential shape", async () => {
    const repositoryPath = await roots.create("docsfab-operator-input-attach-");
    const operatorFiles = await roots.create("docsfab-operator-input-files-");
    const credential = configureCredential(["harbor", plantedCredentialValue(95, 24)].join("-"));
    const withCredential = join(operatorFiles, "notes-configured.md");
    await writeFile(withCredential, `Notes: ${credential}\n`);
    await expect(
      bindOperatorInputFills({
        slots: [TEXT_SLOT],
        attachPaths: [withCredential],
        repositoryPath,
        when: WHEN,
      }),
    ).rejects.toThrow("An attached file contained a configured credential and was withheld.");

    const shaped = ["glpat", plantedCredentialValue(96, 20)].join("-");
    const withShape = join(operatorFiles, "notes-shaped.md");
    await writeFile(withShape, `The old token ${shaped} was rotated.\n`);
    await expect(
      bindOperatorInputFills({
        slots: [TEXT_SLOT],
        attachPaths: [withShape],
        repositoryPath,
        when: WHEN,
      }),
    ).resolves.toEqual([expect.objectContaining({ inputId: "request", source: "operator-file" })]);
  });
});
