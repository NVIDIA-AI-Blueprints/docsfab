// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { preflightTemplatePaths } from "../src/templates/paths.js";
import {
  applyTemplateTransaction,
  MAX_RENDERED_TEMPLATE_BYTES,
  type RenderedTemplateBinding,
  type TemplateTransactionErrorCode,
} from "../src/templates/transaction.js";

let testRoot: string;
let workspace: string;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "docsfab-template-transaction-"));
  workspace = join(testRoot, "workspace");
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("template scaffold transaction", () => {
  it("writes exact UTF-8 content exclusively and returns content-free evidence", async () => {
    const plan = await planFor([
      ["configure-authentication", "docs/guides/configure-authentication.md"],
      ["gpu-clusters", "docs/reference/gpu-clusters.md"],
    ]);
    const rendered = [
      binding("docs/reference/gpu-clusters.md", "# GPU clusters\n\nCafé.\n"),
      binding("docs/guides/configure-authentication.md", "# Configure authentication\n"),
    ];

    const summary = await applyTemplateTransaction({ plan, rendered });

    expect(await readFile(join(workspace, "docs/guides/configure-authentication.md"), "utf8")).toBe(
      "# Configure authentication\n",
    );
    expect(await readFile(join(workspace, "docs/reference/gpu-clusters.md"), "utf8")).toBe(
      "# GPU clusters\n\nCafé.\n",
    );
    expect(summary).toEqual({
      schemaVersion: 1,
      planDigest: plan.digest,
      outputs: [
        evidence("docs/guides/configure-authentication.md", "# Configure authentication\n"),
        evidence("docs/reference/gpu-clusters.md", "# GPU clusters\n\nCafé.\n"),
      ],
      totalByteLength: Buffer.byteLength("# Configure authentication\n# GPU clusters\n\nCafé.\n"),
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain("Configure authentication");
    expect(
      (await lstat(join(workspace, "docs/guides/configure-authentication.md"))).mode & 0o777,
    ).toBe(0o600);
    expect((await lstat(join(workspace, "docs/guides"))).mode & 0o777).toBe(0o700);
  });

  it("rejects a target created after preview and never overwrites it", async () => {
    const plan = await planFor([["race-safe-topic", "docs/race-safe-topic.md"]]);
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs/race-safe-topic.md"), "authored\n");

    await expectCode(
      applyTemplateTransaction({
        plan,
        rendered: [binding("docs/race-safe-topic.md", "generated\n")],
      }),
      "race-detected",
    );
    expect(await readFile(join(workspace, "docs/race-safe-topic.md"), "utf8")).toBe("authored\n");
  });

  it("rolls back files and directories after an injected partial write failure", async () => {
    const plan = await planFor([
      ["first-topic", "docs/new/first-topic.md"],
      ["second-topic", "docs/new/second-topic.md"],
    ]);

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [
            binding("docs/new/first-topic.md", "first\n"),
            binding("docs/new/second-topic.md", "second\n"),
          ],
        },
        {
          afterExclusiveWrite: ({ index }) => {
            if (index === 0) throw new Error("injected failure");
          },
        },
      ),
      "write-failed",
    );

    await expect(lstat(join(workspace, "docs/new/first-topic.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(workspace, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back the complete write set when post-write validation fails", async () => {
    const plan = await planFor([
      ["first-topic", "docs/new/first-topic.md"],
      ["second-topic", "docs/new/second-topic.md"],
    ]);
    let hookObservedCompleteWriteSet = false;

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [
            binding("docs/new/first-topic.md", "first\n"),
            binding("docs/new/second-topic.md", "second\n"),
          ],
        },
        {
          afterAllWrites: async () => {
            expect(await readFile(join(workspace, "docs/new/first-topic.md"), "utf8")).toBe(
              "first\n",
            );
            expect(await readFile(join(workspace, "docs/new/second-topic.md"), "utf8")).toBe(
              "second\n",
            );
            hookObservedCompleteWriteSet = true;
            throw new Error("post-write validation failed");
          },
        },
      ),
      "write-failed",
    );

    expect(hookObservedCompleteWriteSet).toBe(true);
    await expect(lstat(join(workspace, "docs/new/first-topic.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(workspace, "docs/new/second-topic.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(workspace, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the transaction when post-write validation succeeds", async () => {
    const plan = await planFor([["validated-topic", "docs/validated-topic.md"]]);
    let validationCalls = 0;

    const summary = await applyTemplateTransaction(
      {
        plan,
        rendered: [binding("docs/validated-topic.md", "validated\n")],
      },
      {
        afterAllWrites: async () => {
          validationCalls += 1;
          expect(await readFile(join(workspace, "docs/validated-topic.md"), "utf8")).toBe(
            "validated\n",
          );
        },
      },
    );

    expect(validationCalls).toBe(1);
    expect(summary.outputs).toEqual([evidence("docs/validated-topic.md", "validated\n")]);
    expect(await readFile(join(workspace, "docs/validated-topic.md"), "utf8")).toBe("validated\n");
  });

  it("preserves pre-existing authored data while rolling back transaction-owned paths", async () => {
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs/keep.md"), "keep me\n");
    const plan = await planFor([
      ["first-topic", "docs/generated/first-topic.md"],
      ["second-topic", "docs/generated/second-topic.md"],
    ]);

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [
            binding("docs/generated/first-topic.md", "first\n"),
            binding("docs/generated/second-topic.md", "second\n"),
          ],
        },
        {
          afterExclusiveWrite: ({ index }) => {
            if (index === 0) throw new Error("injected failure");
          },
        },
      ),
      "write-failed",
    );

    expect(await readFile(join(workspace, "docs/keep.md"), "utf8")).toBe("keep me\n");
    expect((await lstat(join(workspace, "docs"))).isDirectory()).toBe(true);
    await expect(lstat(join(workspace, "docs/generated"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("detects a symlink parent race immediately before exclusive creation", async () => {
    const docs = join(workspace, "docs");
    const movedDocs = join(workspace, "docs-before-race");
    const outside = join(testRoot, "outside");
    await mkdir(docs);
    await mkdir(outside);
    await writeFile(join(docs, "keep.md"), "keep\n");
    const plan = await planFor([["symlink-safe-topic", "docs/symlink-safe-topic.md"]]);

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [binding("docs/symlink-safe-topic.md", "must stay inside\n")],
        },
        {
          beforeExclusiveWrite: async () => {
            await rename(docs, movedDocs);
            await symlink(outside, docs, "dir");
          },
        },
      ),
      "race-detected",
    );

    await expect(lstat(join(outside, "symlink-safe-topic.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(movedDocs, "keep.md"), "utf8")).toBe("keep\n");
  });

  it("detects a parent swap after the final check and writes no content outside", async () => {
    const docs = join(workspace, "docs");
    const movedDocs = join(workspace, "docs-before-open-race");
    const outside = join(testRoot, "outside-after-final-check");
    await mkdir(docs);
    await mkdir(outside);
    await writeFile(join(docs, "keep.md"), "keep\n");
    const plan = await planFor([["final-check-topic", "docs/final-check-topic.md"]]);

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [binding("docs/final-check-topic.md", "must never reach outside\n")],
        },
        {
          beforeExclusiveOpen: async () => {
            await rename(docs, movedDocs);
            await symlink(outside, docs, "dir");
          },
        },
      ),
      "race-detected",
    );

    await expect(lstat(join(outside, "final-check-topic.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(movedDocs, "final-check-topic.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(movedDocs, "keep.md"), "utf8")).toBe("keep\n");
  });

  it("preserves a replacement at an owned path and reports rollback failure", async () => {
    const plan = await planFor([["replacement-topic", "docs/replacement-topic.md"]]);
    const target = join(workspace, "docs/replacement-topic.md");

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [binding("docs/replacement-topic.md", "generated\n")],
        },
        {
          afterAllWrites: async () => {
            await rm(target);
            await writeFile(target, "maintainer replacement\n");
            throw new Error("post-write validation failed");
          },
        },
      ),
      "rollback-failed",
    );

    expect(await readFile(target, "utf8")).toBe("maintainer replacement\n");
  });

  it("preserves an externally linked created inode and reports rollback failure", async () => {
    const plan = await planFor([["linked-topic", "docs/linked-topic.md"]]);
    const target = join(workspace, "docs/linked-topic.md");
    const externalLink = join(testRoot, "maintainer-link.md");

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [binding("docs/linked-topic.md", "generated\n")],
        },
        {
          afterAllWrites: async () => {
            await link(target, externalLink);
            throw new Error("post-write validation failed");
          },
        },
      ),
      "rollback-failed",
    );

    expect(await readFile(target, "utf8")).toBe("generated\n");
    expect(await readFile(externalLink, "utf8")).toBe("generated\n");
  });

  it("reports rollback failure when the owned path is unlinked but an external hardlink remains", async () => {
    const plan = await planFor([["unlinked-topic", "docs/unlinked-topic.md"]]);
    const target = join(workspace, "docs/unlinked-topic.md");
    const externalLink = join(testRoot, "retained-link.md");

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [binding("docs/unlinked-topic.md", "generated\n")],
        },
        {
          afterAllWrites: async () => {
            await link(target, externalLink);
            await rm(target);
            throw new Error("post-write validation failed");
          },
        },
      ),
      "rollback-failed",
    );

    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(externalLink, "utf8")).toBe("generated\n");
  });

  it("reports rollback failure when the owned inode is renamed outside the transaction", async () => {
    const plan = await planFor([["renamed-topic", "docs/renamed-topic.md"]]);
    const target = join(workspace, "docs/renamed-topic.md");
    const externalPath = join(testRoot, "retained-by-rename.md");

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [binding("docs/renamed-topic.md", "generated\n")],
        },
        {
          afterAllWrites: async () => {
            await rename(target, externalPath);
            throw new Error("post-write validation failed");
          },
        },
      ),
      "rollback-failed",
    );

    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(externalPath, "utf8")).toBe("generated\n");
  });

  it("fails closed when the descriptor-close acceptance gate fails", async () => {
    const plan = await planFor([["close-topic", "docs/close-topic.md"]]);
    const target = join(workspace, "docs/close-topic.md");

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [binding("docs/close-topic.md", "generated\n")],
        },
        {
          closeOwnedFile: async () =>
            Promise.reject(new Error("injected descriptor close failure")),
        },
      ),
      "write-failed",
    );

    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects an external hardlink added immediately before rollback unlink", async () => {
    const plan = await planFor([["rollback-race-topic", "docs/rollback-race-topic.md"]]);
    const target = join(workspace, "docs/rollback-race-topic.md");
    const externalLink = join(testRoot, "rollback-race-link.md");

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [binding("docs/rollback-race-topic.md", "generated\n")],
        },
        {
          afterAllWrites: () => {
            throw new Error("post-write validation failed");
          },
          beforeRollbackUnlink: async () => {
            await link(target, externalLink);
          },
        },
      ),
      "rollback-failed",
    );

    expect(await readFile(target, "utf8")).toBe("generated\n");
    expect(await readFile(externalLink, "utf8")).toBe("generated\n");
  });

  it("preserves a pathname replacement made immediately before rollback removal", async () => {
    const plan = await planFor([["rollback-replacement", "docs/rollback-replacement.md"]]);
    const target = join(workspace, "docs/rollback-replacement.md");
    const movedGenerated = join(testRoot, "moved-generated.md");

    await expectCode(
      applyTemplateTransaction(
        {
          plan,
          rendered: [binding("docs/rollback-replacement.md", "generated\n")],
        },
        {
          afterAllWrites: () => {
            throw new Error("post-write validation failed");
          },
          beforeRollbackUnlink: async () => {
            await rename(target, movedGenerated);
            await writeFile(target, "maintainer replacement\n");
          },
        },
      ),
      "rollback-failed",
    );

    expect(await readFile(target, "utf8")).toBe("maintainer replacement\n");
    expect(await readFile(movedGenerated, "utf8")).toBe("generated\n");
  });

  it("rejects missing, extra, and duplicate rendered bindings before writing", async () => {
    const plan = await planFor([
      ["first-topic", "docs/first-topic.md"],
      ["second-topic", "docs/second-topic.md"],
    ]);
    const first = binding("docs/first-topic.md", "first\n");
    const second = binding("docs/second-topic.md", "second\n");

    await expectCode(applyTemplateTransaction({ plan, rendered: [first] }), "binding-mismatch");
    await expectCode(
      applyTemplateTransaction({
        plan,
        rendered: [first, second, binding("docs/extra.md", "extra\n")],
      }),
      "binding-mismatch",
    );
    await expectCode(
      applyTemplateTransaction({
        plan,
        rendered: [first, first, second],
      }),
      "binding-mismatch",
    );
    await expect(lstat(join(workspace, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-string, NUL, non-round-trippable, and oversized content before writing", async () => {
    const plan = await planFor([["bounded-topic", "docs/bounded-topic.md"]]);
    const invalidValues: unknown[] = [
      Buffer.from("binary"),
      "before\0after",
      "unpaired-high-surrogate:\ud800",
      "x".repeat(MAX_RENDERED_TEMPLATE_BYTES + 1),
    ];

    for (const value of invalidValues) {
      const promise = applyTemplateTransaction({
        plan,
        rendered: [
          {
            relativePath: "docs/bounded-topic.md",
            content: value,
          } as unknown as RenderedTemplateBinding,
        ],
      });
      await expect(promise).rejects.toMatchObject({
        code:
          typeof value === "string" && value.length > MAX_RENDERED_TEMPLATE_BYTES
            ? "content-too-large"
            : "invalid-content",
      });
    }
    await expect(lstat(join(workspace, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a plan mutation before creating directories", async () => {
    const plan = await planFor([["sealed-topic", "docs/sealed-topic.md"]]);
    plan.outputs[0]!.absolutePath = join(workspace, "elsewhere.md");

    await expectCode(
      applyTemplateTransaction({
        plan,
        rendered: [binding("docs/sealed-topic.md", "sealed\n")],
      }),
      "plan-invalid",
    );
    await expect(lstat(join(workspace, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function planFor(outputs: Array<[templateName: string, relativePath: string]>) {
  return preflightTemplatePaths({
    workspacePath: workspace,
    outputs: outputs.map(([templateName, relativePath]) => ({ templateName, relativePath })),
  });
}

function binding(relativePath: string, content: string): RenderedTemplateBinding {
  return { relativePath, content };
}

function evidence(relativePath: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  return {
    relativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: TemplateTransactionErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}
