// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import {
  isSafeRepositoryRelativePath,
  liveAgentDocumentationRoots,
  isLiveAgentDocumentationDirectoryRoot,
  isLiveAgentSessionDocumentationPage,
} from "../src/live-agent/documentation-path-policy.js";

describe("live-agent documentation path policy", () => {
  it("uses repository-relative syntax that permits spaces and non-ASCII names", () => {
    expect(isSafeRepositoryRelativePath("manual/Release Notes.adoc")).toBe(true);
    expect(isSafeRepositoryRelativePath("manual/überblick.adoc")).toBe(true);
    expect(isSafeRepositoryRelativePath("../outside.md")).toBe(false);
    expect(isSafeRepositoryRelativePath("manual\\outside.md")).toBe(false);
  });

  it("admits tracked configured documents with ordinary repository names", () => {
    const configured = ["manual/Release Notes.adoc", "manual/überblick.adoc"];
    expect(liveAgentDocumentationRoots(configured, configured)).toEqual({
      roots: configured,
      dropped: [],
    });
  });

  it("rejects source and CI paths passed as documentation directories", () => {
    expect(() => new DocumentationScope(["src"])).toThrow(/source code/u);
    expect(() => new DocumentationScope([".gitlab/ci"])).toThrow(/CI/u);
  });

  it("allows ordinary Unicode and spaced documentation roots while retaining protected boundaries", () => {
    for (const root of ["manual/Release Notes", "manual/überblick", "manual/it's safe"])
      expect(isLiveAgentDocumentationDirectoryRoot(root), root).toBe(true);
    for (const root of [
      "src",
      "test",
      ".hidden",
      "node_modules/pkg",
      "vendor/docs",
      ".gitlab/ci",
      "manual/entry; rm -rf docs",
      "manual/\u202ehidden",
    ])
      expect(isLiveAgentDocumentationDirectoryRoot(root), root).toBe(false);
  });

  it("keeps session grants limited to safe Markdown pages and protected files", () => {
    expect(isLiveAgentSessionDocumentationPage("manual/Release Notes/install.md")).toBe(true);
    expect(isLiveAgentSessionDocumentationPage("manual/überblick/page.mdx")).toBe(true);
    for (const path of [
      "manual/Release Notes/tool.ts",
      "manual/Release Notes/AGENTS.md",
      "manual/Release Notes/.hidden.md",
      "manual/Release Notes/node_modules/pkg.md",
      "src/README.md",
      ".gitlab/ci/guide.md",
    ])
      expect(isLiveAgentSessionDocumentationPage(path), path).toBe(false);
  });
});
