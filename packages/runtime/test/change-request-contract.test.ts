// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ChangeRequestError,
  createChangeRequestRef,
  decodeChangeRequestRef,
} from "../src/inputs/change-request.js";

const github = {
  provider: "github" as const,
  canonicalHost: "github.com",
  targetRepositoryId: "2048",
  objectKind: "pull-request" as const,
  nativeChangeId: "884",
};

describe("stable shared change request reference", () => {
  it("seals stable provider, host, repository and native change identity", () => {
    const ref = createChangeRequestRef(github);
    expect(decodeChangeRequestRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
    expect(
      createChangeRequestRef({ ...github, targetRepositoryId: "2049" }).referenceSha256,
    ).not.toBe(ref.referenceSha256);
    expect(
      createChangeRequestRef({
        provider: "gitlab",
        canonicalHost: "gitlab.example.test",
        targetRepositoryId: "2048",
        objectKind: "merge-request",
        nativeChangeId: "884",
      }).referenceSha256,
    ).not.toBe(ref.referenceSha256);
  });

  it("refuses unknown fields, wrong versions, cross-kind identity and tampering", () => {
    const ref = createChangeRequestRef(github);
    for (const changed of [
      { ...ref, title: "mutable display title" },
      { ...ref, schemaVersion: 2 },
      { ...ref, nativeChangeId: "885" },
      { ...ref, targetRepositoryId: "02048" },
      { ...ref, objectKind: "merge-request" },
    ]) {
      expect(() => decodeChangeRequestRef(changed)).toThrow(ChangeRequestError);
    }
    expect(() => createChangeRequestRef({ ...github, canonicalHost: "www.github.com" })).toThrow(
      ChangeRequestError,
    );
    expect(() => createChangeRequestRef({ ...github, nativeChangeId: "0" })).toThrow(
      ChangeRequestError,
    );
  });
});
