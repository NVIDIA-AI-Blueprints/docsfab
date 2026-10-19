// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { limit, resolveLimits } from "../src/config/limits.js";

describe("effective review source retention limits", () => {
  it("publishes the reviewed defaults and admits a valid paired override", () => {
    expect(limit("reviewDelivery.snapshotUniqueOriginalBytesMax").value).toBe(268435456);
    expect(limit("reviewDelivery.snapshotPartBytes").value).toBe(8388608);
    const rows = resolveLimits({
      environment: {
        DOCSFAB_REVIEW_DELIVERY_SNAPSHOT_UNIQUE_ORIGINAL_BYTES_MAX: "536870912",
        DOCSFAB_CHANGE_SOURCES_GITHUB_OBJECT_MATERIALIZED_MAX_BYTES: "536870912",
        DOCSFAB_REVIEW_DELIVERY_SNAPSHOT_PART_BYTES: "4194304",
      },
    });
    expect(
      rows.find((row) => row.name === "reviewDelivery.snapshotUniqueOriginalBytesMax"),
    ).toMatchObject({
      value: 536870912,
      source: "host",
    });
    expect(rows.find((row) => row.name === "reviewDelivery.snapshotPartBytes")).toMatchObject({
      value: 4194304,
      source: "host",
    });
  });

  it("refuses a GitHub object ceiling above effective retention capacity", () => {
    expect(() =>
      resolveLimits({
        environment: {
          DOCSFAB_CHANGE_SOURCES_GITHUB_OBJECT_MATERIALIZED_MAX_BYTES: "536870912",
        },
      }),
    ).toThrow(
      /changeSourcesGithub\.objectMaterializedMaxBytes.*reviewDelivery\.snapshotUniqueOriginalBytesMax/u,
    );
  });
});
