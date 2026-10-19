// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import {
  countingInterpreter,
  fixture,
  prepared,
  runRequest,
  task,
} from "./rst-capability-preflight-support.js";

describe("RST capability compatibility", () => {
  it("does not reject a canonical Markdown target just because the repository also tracks RST", async () => {
    const fixtureData = await fixture();
    const preflight = await prepared(
      fixtureData,
      task(fixtureData.repositoryPath, fixtureData.revision, ["src/change.md"]),
      false,
    );

    expect(preflight).not.toHaveProperty("rstUpdatePaths");
  });

  it("admits one normalized RST update into the exact downstream target scope", async () => {
    const fixtureData = await fixture();
    const preflight = await prepared(
      fixtureData,
      task(fixtureData.repositoryPath, fixtureData.revision, ["docs/guide.rst"]),
      true,
    );

    expect(preflight).toMatchObject({ rstUpdatePaths: ["docs/guide.rst"] });
  });

  it("does not reject unbound read-only review or source context containing RST", async () => {
    const fixtureData = await fixture();
    const model = countingInterpreter();
    const reviewRequest: RunRequestWithPublishProjection = {
      workflow: "audit-documentation",
      repositoryPath: fixtureData.repositoryPath,
      revision: "HEAD",
      allowWrite: false,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
      sourcePaths: ["docs/guide.rst"],
    };
    const failure = await executeRunRequest(reviewRequest, fixtureData.config, {
      requestInterpreter: model.port,
    }).catch((error: unknown) => error);

    expect(failure).not.toMatchObject({
      code: expect.stringMatching(/^rst-capability-/u),
    });
  });

  it("keeps an unbound patch-only request eligible for the existing RST discovery path", async () => {
    const fixtureData = await fixture();
    const preflight = await prepared(fixtureData, null, true);

    expect(preflight).toMatchObject({
      rstUpdatePaths: ["docs/guide.rst", "docs/index.rst", "docs/other.rst"],
    });
  });
});
