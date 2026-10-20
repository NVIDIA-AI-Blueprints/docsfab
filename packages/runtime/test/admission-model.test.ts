// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { liveAdmitCatalogWorkflow } from "../src/cli/admission-model.js";
import { VIRTUAL_WORKSPACE_CWD } from "../src/harness/pi-session.js";
import { validModelConfig } from "./helpers.js";
import { textTurn } from "./support/pi-harness-session-fixtures.js";

const installRoot = vi.hoisted(() => ({ path: "" }));

vi.mock("../src/config/runtime-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/runtime-loader.js")>()),
  loadConfig: () => ({ projectRoot: installRoot.path, model: validModelConfig }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("admission-model provider request", () => {
  it("sends the virtual workspace cwd, never the install root", async () => {
    installRoot.path = await mkdtemp(resolve(tmpdir(), "docsfab-admission-install-"));
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_request: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return textTurn("review-documentation");
    });
    // The suite sets PI_OFFLINE, which makes the admission model return early.
    vi.stubEnv("PI_OFFLINE", "0");
    try {
      await liveAdmitCatalogWorkflow("Review the CLI guide.");
    } finally {
      await rm(installRoot.path, { recursive: true, force: true });
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`<cwd>\\n${VIRTUAL_WORKSPACE_CWD}\\n</cwd>`);
    expect(bodies[0]).not.toContain(installRoot.path);
  });
});
