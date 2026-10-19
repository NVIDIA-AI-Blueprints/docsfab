// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import {
  assertModelRequestCredentialFree,
  CredentialBoundaryError,
} from "../src/security/credential-isolation.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

// Synthetic, never-real token shapes. They are never echoed by the boundary.
const GITLAB_TOKEN = `glpat-${"a".repeat(24)}`;
const NVIDIA_TOKEN = `nvapi-${"b".repeat(24)}`;
const BOUNDARY_MESSAGE =
  "DocsFab rejected data at a governed credential-isolation boundary before host credential material could escape.";

const temporaryDirectories = temporaryRoots();

async function interceptFixture() {
  const root = await temporaryDirectories.create("docsfab-confined-c04-");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "docs", "guide.md"), "alpha old\n", "utf8");
  await writeFile(
    join(workspace, "docs", "gitlab-shaped.md"),
    `token line ${GITLAB_TOKEN}\n`,
    "utf8",
  );
  await writeFile(
    join(workspace, "docs", "nvidia-shaped.md"),
    `NVIDIA_API_KEY=${NVIDIA_TOKEN}\n`,
    "utf8",
  );

  const toolSet = await createConfinedToolSet({
    workspacePath: workspace,
    allowWrite: false,
  });
  const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
  const call = async (name: string, parameters: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(`test-${name}`, parameters, undefined, undefined, undefined as never);
  };

  return { toolSet, call };
}

async function expectContentFreeToolFailure(
  execute: () => Promise<unknown>,
  token: string,
): Promise<Error> {
  let error: unknown;
  try {
    await execute();
    throw new Error("Expected the confined tool to fail closed.");
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(CredentialBoundaryError);
  const failure = error as Error;
  expect(failure.message).toBe(BOUNDARY_MESSAGE);
  expect(failure.message).not.toContain(token);
  expect(String(error)).not.toContain(token);
  return failure;
}

describe("confined tool C-04 result intercept", () => {
  it("fails read as a content-free tool error when the result would trip C-04", async () => {
    configureCredential(GITLAB_TOKEN);
    const { call, toolSet } = await interceptFixture();
    const failure = await expectContentFreeToolFailure(
      () => call("read", { path: "docs/gitlab-shaped.md" }),
      GITLAB_TOKEN,
    );

    expect(toolSet.getFailureCategories()).toEqual([]);
    expect(() =>
      assertModelRequestCredentialFree({
        systemPrompt: "Improve the documentation.",
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }] },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            isError: true,
            content: [{ type: "text", text: failure.message }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("fails grep as a content-free tool error when a match would trip C-04", async () => {
    configureCredential(NVIDIA_TOKEN);
    const { call } = await interceptFixture();
    await expectContentFreeToolFailure(
      () =>
        call("grep", {
          path: "docs/nvidia-shaped.md",
          pattern: "NVIDIA_API_KEY",
          literal: true,
        }),
      NVIDIA_TOKEN,
    );
  });

  it("returns a file that only looks like a credential, in read and grep (#1807)", async () => {
    const { call } = await interceptFixture();
    expect(JSON.stringify(await call("read", { path: "docs/gitlab-shaped.md" }))).toContain(
      GITLAB_TOKEN,
    );
    expect(
      JSON.stringify(
        await call("grep", {
          path: "docs/nvidia-shaped.md",
          pattern: "NVIDIA_API_KEY",
          literal: true,
        }),
      ),
    ).toContain(NVIDIA_TOKEN);
  });

  it("still rejects a configured credential if it reaches the outbound graph", async () => {
    configureCredential(NVIDIA_TOKEN);
    const leakedGraph = {
      systemPrompt: "Improve the documentation.",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }] },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: `NVIDIA_API_KEY=${NVIDIA_TOKEN}` }],
        },
      ],
    };
    expect(() => assertModelRequestCredentialFree(leakedGraph)).toThrow(CredentialBoundaryError);
  });

  it("lets benign read and grep continue while a token-shaped file sits unused", async () => {
    const { call } = await interceptFixture();

    const read = await call("read", { path: "docs/guide.md" });
    expect(JSON.stringify(read)).toContain("alpha old");
    expect(JSON.stringify(read)).not.toContain(GITLAB_TOKEN);
    expect(JSON.stringify(read)).not.toContain(NVIDIA_TOKEN);

    const grep = await call("grep", {
      path: "docs",
      pattern: "alpha",
      literal: true,
    });
    expect(JSON.stringify(grep)).toContain("alpha old");
    expect(JSON.stringify(grep)).not.toContain(GITLAB_TOKEN);
    expect(JSON.stringify(grep)).not.toContain(NVIDIA_TOKEN);

    expect(() =>
      assertModelRequestCredentialFree({
        systemPrompt: "Improve the documentation.",
        messages: [
          { role: "user", content: "Fix the heading and add a runnable example." },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: (read as { content: unknown }).content,
          },
        ],
      }),
    ).not.toThrow();
  });
});
