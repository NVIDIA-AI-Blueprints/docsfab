// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_TEMPLATE_OUTPUTS,
  preflightTemplatePaths,
  recheckTemplatePathPlan,
  type ProposedTemplatePath,
  type TemplatePathErrorCode,
} from "../src/templates/paths.js";

let testRoot: string;
let workspace: string;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "docsfab-template-paths-"));
  workspace = join(testRoot, "workspace");
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("template output path preflight", () => {
  it("bounds the number of outputs retained by one transaction", async () => {
    const outputs = Array.from({ length: MAX_TEMPLATE_OUTPUTS + 1 }, (_unused, index) => {
      const suffix = String(index).padStart(4, "0");
      return output(`topic-${suffix}`, `docs/topic-${suffix}.md`);
    });
    await expectCode(preflightTemplatePaths({ workspacePath: workspace, outputs }), "unsafe-path");
    await expect(lstat(join(workspace, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a sealed canonical plan for approved topic slugs without writing", async () => {
    const canonicalWorkspace = await realpath(workspace);
    const plan = await preflightTemplatePaths({
      workspacePath: canonicalWorkspace,
      outputs: [
        output("configure-authentication", "docs/guides/configure-authentication.md"),
        output("gpu-clusters", "docs/reference/gpu-clusters.md"),
      ],
    });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      workspacePath: canonicalWorkspace,
      outputs: [
        {
          templateName: "configure-authentication",
          relativePath: "docs/guides/configure-authentication.md",
          absolutePath: join(canonicalWorkspace, "docs/guides/configure-authentication.md"),
        },
        {
          templateName: "gpu-clusters",
          relativePath: "docs/reference/gpu-clusters.md",
          absolutePath: join(canonicalWorkspace, "docs/reference/gpu-clusters.md"),
        },
      ],
    });
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.outputs[0]!.missingParentDirectories).toEqual([
      join(canonicalWorkspace, "docs"),
      join(canonicalWorkspace, "docs/guides"),
    ]);
    await expect(lstat(join(workspace, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(plan.outputs.every((item) => isAbsolute(item.absolutePath))).toBe(true);
  });

  it.each(["", "template", "page", "document", "untitled", "General", "not approved"])(
    "rejects an empty, generic, or unapproved topic name %j",
    async (templateName) => {
      await expectCode(
        preflightTemplatePaths({
          workspacePath: workspace,
          outputs: [output(templateName, "docs/topic.md")],
        }),
        "invalid-template-name",
      );
    },
  );

  it.each([
    "feature",
    "about-feature",
    "concept",
    "conceptual",
    "conceptual-blended",
    "procedural",
    "procedural-task",
    "about-procedural-task",
    "single-procedural",
    "single-procedural-task",
    "multiple-procedural",
    "multiple-procedural-tasks",
  ])("rejects the upstream tpl-new-page generic descriptor %s", async (templateName) => {
    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output(templateName, `docs/${templateName}.md`)],
      }),
      "invalid-template-name",
    );
  });

  it.each([
    "/tmp/escape.md",
    "../escape.md",
    "docs/../../escape.md",
    "docs/escape\0.md",
    "docs\\escape.md",
    "C:/escape.md",
    "//server/share.md",
    "docs//page.md",
    "docs/./page.md",
    "docs/CON.md",
    "docs/page?.md",
  ])("rejects unsafe cross-platform path %j", async (relativePath) => {
    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("safe-topic", relativePath)],
      }),
      "unsafe-path",
    );
  });

  it("rejects exact, case-folded, and Unicode-normalized duplicate outputs", async () => {
    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("first-topic", "docs/Topic.md"), output("second-topic", "docs/topic.md")],
      }),
      "duplicate-path",
    );
    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("first-topic", "docs/topic.md"), output("second-topic", "docs/topic.md")],
      }),
      "duplicate-path",
    );
    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("unicode-topic", "docs/straße.md")],
      }),
      "unsafe-path",
    );
  });

  it("rejects output paths that already exist as files or directories", async () => {
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs/existing.md"), "existing\n");
    await mkdir(join(workspace, "docs/existing-directory"));

    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("existing-file", "docs/existing.md")],
      }),
      "path-exists",
    );
    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("existing-directory", "docs/existing-directory")],
      }),
      "path-exists",
    );
  });

  it("rejects portable case-folded collisions with existing workspace entries", async () => {
    await mkdir(join(workspace, "Docs"));

    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("new-topic", "docs/new-topic.md")],
      }),
      "portable-path-collision",
    );
  });

  it("rejects symlink ancestors and symlink output targets without following them", async () => {
    const outside = join(testRoot, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "existing.md"), "outside\n");
    await symlink(outside, join(workspace, "linked-docs"), "dir");
    await symlink(join(outside, "existing.md"), join(workspace, "linked-page.md"), "file");

    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("escaped-topic", "linked-docs/new.md")],
      }),
      "symlink-component",
    );
    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("linked-topic", "linked-page.md")],
      }),
      "symlink-component",
    );
    expect(await lstat(join(workspace, "linked-docs"))).toMatchObject({});
  });

  it("rejects existing parent files and proposed parent/file collisions", async () => {
    await writeFile(join(workspace, "docs"), "not a directory\n");
    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [output("nested-topic", "docs/nested/topic.md")],
      }),
      "parent-file-collision",
    );

    await rm(join(workspace, "docs"));
    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [
          output("parent-topic", "docs/topic"),
          output("nested-topic", "docs/topic/details.md"),
        ],
      }),
      "parent-file-collision",
    );
  });

  it("does not create a valid prefix when a later output fails preflight", async () => {
    await mkdir(join(workspace, "occupied"));
    await writeFile(join(workspace, "occupied/existing.md"), "existing\n");

    await expectCode(
      preflightTemplatePaths({
        workspacePath: workspace,
        outputs: [
          output("new-topic", "new/nested/topic.md"),
          output("occupied-topic", "occupied/existing.md"),
        ],
      }),
      "path-exists",
    );
    await expect(lstat(join(workspace, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks for races immediately before creation", async () => {
    const plan = await preflightTemplatePaths({
      workspacePath: workspace,
      outputs: [output("race-safe-topic", "docs/race-safe-topic.md")],
    });
    await mkdir(dirname(plan.outputs[0]!.absolutePath), { recursive: true });
    await writeFile(plan.outputs[0]!.absolutePath, "raced\n");

    await expectCode(recheckTemplatePathPlan(plan), "path-exists");
  });

  it("rejects a mutated plan before touching the filesystem", async () => {
    const plan = await preflightTemplatePaths({
      workspacePath: workspace,
      outputs: [output("sealed-topic", "docs/sealed-topic.md")],
    });
    plan.outputs[0]!.relativePath = "docs/changed.md";

    await expectCode(recheckTemplatePathPlan(plan), "plan-changed");
    await expect(lstat(join(workspace, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink supplied as the disposable workspace", async () => {
    const alias = join(testRoot, "workspace-alias");
    await symlink(workspace, alias, "dir");

    await expectCode(
      preflightTemplatePaths({
        workspacePath: alias,
        outputs: [output("safe-topic", "docs/safe-topic.md")],
      }),
      "invalid-workspace",
    );
  });
});

function output(templateName: string, relativePath: string): ProposedTemplatePath {
  return { templateName, relativePath };
}

async function expectCode(promise: Promise<unknown>, code: TemplatePathErrorCode): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}
