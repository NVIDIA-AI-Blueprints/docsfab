// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The hosted worker's complete-output carrier and its entry-point resolution.
 * The accounting cases measure real serialized bytes, and the invocation cases
 * spawn the real entry module.
 */
import { constants as bufferConstants } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  HOSTED_OUTPUT_LINE_FRAME,
  HOSTED_OUTPUT_LINE_MAXIMUM_BYTES,
  HostedOutputCapacityError,
  serializeHostedOutputLine,
} from "../src/host-invoker/contracts.js";

describe("hosted complete-output capacity", () => {
  it("states the engine's supported carrier rather than a configured allowance", () => {
    expect(HOSTED_OUTPUT_LINE_MAXIMUM_BYTES).toBe(bufferConstants.MAX_STRING_LENGTH);
    expect(HOSTED_OUTPUT_LINE_FRAME).toBe("\n");
  });

  it("accounts exact serialized bytes including quotes, escapes and framing", () => {
    for (const value of [
      { text: "ordinary" },
      { text: "é" },
      { text: "\u{1F600}" },
      { text: 'quote " backslash \\ newline \n' },
      { text: "\uD800" },
      [],
      null,
    ]) {
      const accounted = serializeHostedOutputLine(value);
      const json = JSON.stringify(value);
      expect(accounted.json).toBe(json);
      expect(accounted.bytes).toBe(Buffer.byteLength(json, "utf8"));
      expect(accounted.framedBytes).toBe(accounted.bytes + 1);
      // The measured cost is UTF-8 bytes, not UTF-16 units, wherever they differ.
      expect(accounted.bytes).toBeGreaterThanOrEqual(json.length);
    }
    // A lone surrogate is escaped by the serializer, so the delivered line is
    // well-formed UTF-8 and the host's fatal decoder never sees a stray unit.
    expect(serializeHostedOutputLine({ text: "\uD800" }).json).toContain("\\ud800");
  });

  it("refuses an unrepresentable complete output by code instead of truncating it", () => {
    const overCarrier = {
      toJSON() {
        throw new RangeError("Invalid string length");
      },
    };
    expect(() => serializeHostedOutputLine(overCarrier)).toThrow(HostedOutputCapacityError);
    try {
      serializeHostedOutputLine(overCarrier);
      expect.unreachable();
    } catch (error) {
      expect((error as HostedOutputCapacityError).code).toBe("hosted-output-line-max-bytes-bound");
      expect((error as Error).message).toContain(String(HOSTED_OUTPUT_LINE_MAXIMUM_BYTES));
    }
    // A value with no JSON representation at all is its own coded refusal.
    try {
      serializeHostedOutputLine(undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as HostedOutputCapacityError).code).toBe("hosted-output-line-unserializable");
    }
    // A serializer failure that is not a representation bound keeps its own
    // error.
    const projectionFailure = {
      toJSON() {
        throw new TypeError("fixture projection failure");
      },
    };
    expect(() => serializeHostedOutputLine(projectionFailure)).toThrow(TypeError);
    expect(() => serializeHostedOutputLine(projectionFailure)).not.toThrow(
      HostedOutputCapacityError,
    );
  });
});

describe("hosted worker entry-point resolution", () => {
  async function runEntry(entry: string, requestPath: string): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", entry, "--request-fd", "3"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe", openSync(requestPath, "r")],
      });
      child.stdout?.resume();
      child.stderr?.resume();
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
  }

  it("runs when invoked through a symlink, exactly as the installed release does", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-entry-")));
    try {
      const requestPath = join(root, "request.json");
      // Structurally valid JSON, not a valid hosted request: the worker refuses
      // it and exits non-zero, which is how a run proves it actually started.
      await writeFile(requestPath, "{}");
      const real = fileURLToPath(new URL("../src/host-invoker/main.ts", import.meta.url));
      const linked = join(root, "installed-invoker.ts");
      await symlink(real, linked);
      // Node resolves the module through the real path while argv keeps the
      // symlink, so an entry check without realpath would exit 0 having done
      // nothing, and the host would wait for a terminal that never comes.
      expect(await runEntry(linked, requestPath)).toBe(1);
      expect(await runEntry(real, requestPath)).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
