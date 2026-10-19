// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  GithubPrLocatorError,
  githubPrReference,
  parseGithubPrLocator,
} from "../src/inputs/github-pr-locator.js";

describe("explicit public GitHub PR locator", () => {
  it("treats whole-PR views and www as one stable target identity", () => {
    const urls = [
      "https://github.com/Owner/Repo/pull/884",
      "https://www.github.com/Owner/Repo/pull/884/files",
      "https://github.com/Owner/Repo/pull/884/changes/",
    ];
    const locations = urls.map(parseGithubPrLocator);
    expect(locations.map((entry) => entry.canonicalUrl)).toEqual(
      Array(3).fill("https://github.com/Owner/Repo/pull/884"),
    );
    expect(locations.map((entry) => githubPrReference(entry, 2048).referenceSha256)).toEqual(
      Array(3).fill(githubPrReference(locations[0]!, 2048).referenceSha256),
    );
    expect(githubPrReference(locations[0]!, 2049).referenceSha256).not.toBe(
      githubPrReference(locations[0]!, 2048).referenceSha256,
    );
  });

  it("refuses credentials, partial views and ambiguous URL syntax", () => {
    for (const value of [
      "http://github.com/Owner/Repo/pull/884",
      "https://name:secret@github.com/Owner/Repo/pull/884",
      "https://github.com:444/Owner/Repo/pull/884",
      "https://github.example.test/Owner/Repo/pull/884",
      "https://github.com/Owner/Repo/pull/884?diff=split",
      "https://github.com/Owner/Repo/pull/884#files",
      "https://github.com/Owner/Repo/pull/884/commits",
      "https://github.com/Owner/Repo/pull/884/files/1",
      "https://github.com/Owner/Repo.git/pull/884",
      "https://github.com/Owner/Repo.GIT/pull/884",
      "https://github.com/Owner/Repo/pull/01",
      "https://github.com/Owner/Repo/pull/0",
      "https://github.com/Owner/Repo/pull/884%2Ffiles",
      "https://github.com/Owner/Repo/../Other/pull/884",
      "https://github.com/Owner\\Repo/pull/884",
    ]) {
      expect(() => parseGithubPrLocator(value), value).toThrow(GithubPrLocatorError);
    }
  });
});
