// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Read pinned original sides from local Git objects before review model dispatch. */
import {
  MAX_GIT_OUTPUT_BYTES,
  readTrustedGitBlob,
  runTrustedGit,
} from "../../host-invoker/trusted-git.js";
import type { ResolveLimitsOptions } from "../../config/limits.js";
import type { ChangeSourceObjectFormat } from "../change-source.js";
import type {
  ReviewOriginalSideReader,
  SidePreflight,
} from "../../review-delivery/source-snapshot-writer.js";
import { objectId, readObjects, type RawObjectReader } from "./objects.js";
import { GIT_FULL_OBJECT_ID } from "./revision.js";

type VerifiedPreflight = Extract<SidePreflight, { readonly kind: "verified" }>;

export type OriginalSideReaderRefusalCode =
  | "original-side-input-invalid"
  | "original-side-inspect-invalid"
  | "original-side-type-mismatch"
  | "original-side-read-uninspected"
  | "original-side-read-missing"
  | "original-side-length-mismatch"
  | "original-side-object-id-mismatch";

export class OriginalSideReaderError extends Error {
  public readonly code: OriginalSideReaderRefusalCode;

  public constructor(code: OriginalSideReaderRefusalCode) {
    super(`Pinned review original side refused (${code}); check the local Git object and retry.`);
    this.name = "OriginalSideReaderError";
    this.code = code;
  }
}

function fail(code: OriginalSideReaderRefusalCode): never {
  throw new OriginalSideReaderError(code);
}

function validId(id: string, format: ChangeSourceObjectFormat): boolean {
  return GIT_FULL_OBJECT_ID.test(id) && id.length === (format === "sha256" ? 64 : 40);
}

/**
 * Bind the writer's exact reader port to one object database. Inspect reports
 * Git's actual object type and length; read independently verifies its bytes.
 * Paths are never reopened or used as a fallback source of original content.
 */
export function createChangeSourceOriginalSideReader(
  reader: RawObjectReader,
  readPinnedBlob?: (id: string, byteLength: number) => Promise<Buffer>,
): ReviewOriginalSideReader {
  const inspected = new Map<string, VerifiedPreflight>();
  const key = (ordinal: number, side: "before" | "after") => `${ordinal}:${side}`;
  return {
    async inspect(input) {
      if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || !input.path)
        fail("original-side-input-invalid");
      if (input.mode === "160000") return { kind: "unavailable", reason: "unsupported-gitlink" };
      if (input.mode !== "100644" && input.mode !== "100755" && input.mode !== "120000")
        return { kind: "unavailable", reason: "unsupported-mode" };
      const id = input.blobId;
      if (id === null || !validId(id, reader.objectFormat)) fail("original-side-input-invalid");
      const output = await reader.run(["cat-file", "--batch-check"], {
        input: Buffer.from(`${id}\n`, "latin1"),
      });
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-z]+) ([0-9]+)\n$/u.exec(
        output.toString("latin1"),
      );
      if (!match || match[1] !== id) fail("original-side-inspect-invalid");
      if (match[2] !== "blob") fail("original-side-type-mismatch");
      const byteLength = Number(match[3]);
      if (!Number.isSafeInteger(byteLength)) fail("original-side-inspect-invalid");
      const preflight: VerifiedPreflight = {
        kind: "verified",
        objectId: id,
        objectType: "blob",
        byteLength,
      };
      inspected.set(key(input.ordinal, input.side), preflight);
      return preflight;
    },
    async read(input) {
      const prior = inspected.get(key(input.ordinal, input.side));
      if (
        prior === undefined ||
        input.expected.kind !== "verified" ||
        input.expected.objectType !== "blob" ||
        input.expected.objectId !== prior.objectId ||
        input.expected.byteLength !== prior.byteLength
      )
        fail("original-side-read-uninspected");
      const object = readPinnedBlob
        ? {
            type: "blob",
            body: await readPinnedBlob(prior.objectId, prior.byteLength),
          }
        : (await readObjects(reader, [prior.objectId])).get(prior.objectId);
      if (object === undefined) fail("original-side-read-missing");
      if (object.type !== "blob") fail("original-side-type-mismatch");
      if (object.body.byteLength !== prior.byteLength) fail("original-side-length-mismatch");
      if (objectId(reader.objectFormat, "blob", object.body) !== prior.objectId)
        fail("original-side-object-id-mismatch");
      return Uint8Array.from(object.body);
    },
  };
}

/** Production reader: one trusted, bounded, no-network Git process per object read. */
export function createWorkspaceOriginalSideReader(input: {
  readonly sourcePath: string;
  readonly objectFormat: ChangeSourceObjectFormat;
  readonly signal?: AbortSignal;
  readonly limits?: ResolveLimitsOptions;
}): ReviewOriginalSideReader {
  return createChangeSourceOriginalSideReader(
    {
      objectFormat: input.objectFormat,
      shallow: false,
      run: (args, options) =>
        runTrustedGit(input.sourcePath, args, input.signal, MAX_GIT_OUTPUT_BYTES, options?.input),
    },
    (objectId, expectedByteLength) =>
      readTrustedGitBlob({
        sourcePath: input.sourcePath,
        objectId,
        objectFormat: input.objectFormat,
        expectedByteLength,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
      }),
  );
}
