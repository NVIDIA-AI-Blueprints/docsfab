// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { vi } from "vitest";

// This fixture belongs only to private-route qualification inside Vitest.
// Product source, launcher subprocesses, and package builds never read it.
const fixture = process.env.DOCSFAB_TEST_PRIVATE_ROUTE_BASE_URL;
if (fixture !== undefined) {
  const original = await vi.importActual("../../src/config/private-route-urls.js");
  let endpoint;
  try {
    endpoint = new URL(fixture);
  } catch {
    throw new Error("The private-route qualification fixture is not a valid endpoint.");
  }
  const path = endpoint.pathname.replace(/\/$/u, "");
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    path !== "/v1" ||
    createHash("sha256").update(endpoint.origin).digest("hex") !==
      original.PRIVATE_EXECUTABLE_ROUTE_ORIGIN_SHA256["nvidia-inference-api"]
  ) {
    throw new Error("The private-route qualification fixture does not match the recorded origin.");
  }
  vi.doMock("../../src/config/private-route-urls.js", () => ({
    ...original,
    PRIVATE_EXECUTABLE_ROUTE_BASE_URLS: Object.freeze({
      ...original.PRIVATE_EXECUTABLE_ROUTE_BASE_URLS,
      "nvidia-inference-api": `${endpoint.origin}${path}`,
    }),
  }));
  process.stderr.write("Private-route qualification uses a Vitest-only endpoint fixture.\n");
}
