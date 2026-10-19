// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The revision object ID of a tracked page is returned only when the file at
 * that path hashes to it: in either Git object format, through a file system
 * that refuses the read, and while the file changes under the read.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { trackedRepositoryBlobObjectId } from "../src/repository/workspace/tracked-read.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const PAGE = "docs/guide.md";
const BYTES = "# Guide\n\nThe API exposes a safe default.\n";

/** What the next `open` of the page does instead of opening it, or around its read. */
const control = vi.hoisted(() => ({
  failOpenWith: undefined as string | undefined,
  duringRead: undefined as ((absolute: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (path, ...rest) => {
    const target = String(path);
    if (!target.endsWith(PAGE)) return actual.open(path, ...rest);
    if (control.failOpenWith) {
      throw Object.assign(new Error(`${control.failOpenWith}: fixture open refusal`), {
        code: control.failOpenWith,
      });
    }
    const handle = await actual.open(path, ...rest);
    const hook = control.duringRead;
    if (!hook) return handle;
    const createReadStream = handle.createReadStream.bind(handle);
    // Run the hook after the first chunk is hashed and before the rest is read.
    handle.createReadStream = ((options) => {
      const stream = createReadStream(options);
      return (async function* () {
        let first = true;
        for await (const chunk of stream) {
          yield chunk;
          if (first) {
            first = false;
            await hook(target);
          }
        }
      })();
    }) as typeof handle.createReadStream;
    return handle;
  };
  return { ...actual, default: { ...actual, open }, open };
});

const temporary = temporaryRoots();

function gitBlobObjectId(text: string, algorithm: "sha1" | "sha256"): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

async function workspaceAt(objectFormat: "sha1" | "sha256", bytes = BYTES) {
  const source = await temporary.create("docsfab-blob-object-id-");
  const revision = await initFixtureRepo(source, { [PAGE]: bytes }, { objectFormat });
  return prepareRepositoryWorkspace(source, revision);
}

afterEach(() => {
  control.failOpenWith = undefined;
  control.duringRead = undefined;
});

describe("revision object ID of a tracked page", () => {
  it.each(["sha1", "sha256"] as const)(
    "hashes the page in the repository's own object format (%s)",
    async (objectFormat) => {
      const workspace = await workspaceAt(objectFormat);
      try {
        const objectId = await trackedRepositoryBlobObjectId(workspace, PAGE);
        expect(objectId).toBe(gitBlobObjectId(BYTES, objectFormat));
      } finally {
        await workspace.dispose();
      }
    },
  );

  it.each([
    ["EACCES", "read-failed"],
    ["EPERM", "read-failed"],
    ["EIO", "read-failed"],
    ["ELOOP", "changed"],
  ])("reports an open that fails with %s as %s", async (code, expected) => {
    const workspace = await workspaceAt("sha1");
    try {
      control.failOpenWith = code;
      await expect(trackedRepositoryBlobObjectId(workspace, PAGE)).rejects.toMatchObject({
        name: "RepositoryWorkspaceReadError",
        code: expected,
      });
    } finally {
      await workspace.dispose();
    }
  });

  it("refuses a page whose metadata changes while it is read, though its bytes do not", async () => {
    // Several read chunks, so the change lands between two of them.
    const bytes = `# Guide\n${"x".repeat(1024 * 1024)}\n`;
    const workspace = await workspaceAt("sha1", bytes);
    try {
      const { utimes } =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let changed = false;
      control.duringRead = async (absolute) => {
        changed = true;
        await utimes(absolute, new Date(0), new Date(0));
      };
      await expect(trackedRepositoryBlobObjectId(workspace, PAGE)).rejects.toMatchObject({
        name: "RepositoryWorkspaceReadError",
        code: "changed",
      });
      expect(changed).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });
});
