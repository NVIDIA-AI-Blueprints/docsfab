// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalDigest, sha256 } from "../src/content-ir/canonical.js";
import { runCliEntrypoint } from "../src/operator/cli-entrypoint.js";
import {
  compareText,
  hasErrnoCode,
  isNodeError,
  isPlainRecord,
  isRecord,
  pathExists,
} from "../src/shared/primitives.js";

// sha256("abc") from FIPS 180-2 appendix B.1.
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("shared sha256", () => {
  it("hashes a string as its UTF-8 bytes, identical to the byte input", () => {
    expect(sha256("abc")).toBe(ABC_SHA256);
    expect(sha256(new Uint8Array([0x61, 0x62, 0x63]))).toBe(ABC_SHA256);
    expect(sha256(Buffer.from("abc", "utf8"))).toBe(ABC_SHA256);
    expect(sha256("é")).toBe(sha256(Buffer.from("é", "utf8")));
    expect(sha256("é")).not.toBe(sha256(Buffer.from("é", "latin1")));
  });

  it("keeps canonicalDigest bound to sha256 of canonical JSON", () => {
    expect(canonicalDigest({ b: 1, a: 2 })).toBe(sha256('{"a":2,"b":1}'));
  });
});

describe("compareText", () => {
  it("orders by UTF-16 code unit, not locale", () => {
    expect(["b", "a", "B", "ä", "A"].sort(compareText)).toEqual(["A", "B", "a", "b", "ä"]);
    expect(compareText("a", "a")).toBe(0);
    expect(compareText("a", "b")).toBe(-1);
    expect(compareText("b", "a")).toBe(1);
    expect(compareText("B", "a")).toBe(-1);
    expect("B".localeCompare("a")).toBe(1);
  });
});

describe("record guards", () => {
  class Box {
    value = 1;
  }

  it("isRecord accepts any non-null non-array object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Box())).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("text")).toBe(false);
  });

  it("isPlainRecord accepts only objects that inherit directly from Object.prototype", () => {
    expect(isPlainRecord({ key: "value" })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(false);
    expect(isPlainRecord(new Box())).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(0)).toBe(false);
  });
});

describe("error-code guards", () => {
  const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });

  it("isNodeError requires an Error instance with the exact code", () => {
    expect(isNodeError(enoent, "ENOENT")).toBe(true);
    expect(isNodeError(enoent, "EEXIST")).toBe(false);
    expect(isNodeError({ code: "ENOENT" }, "ENOENT")).toBe(false);
    expect(isNodeError(new Error("no code"), "ENOENT")).toBe(false);
  });

  it("hasErrnoCode accepts any object carrying the exact code", () => {
    expect(hasErrnoCode(enoent, "ENOENT")).toBe(true);
    expect(hasErrnoCode({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(hasErrnoCode({ code: "EEXIST" }, "ENOENT")).toBe(false);
    expect(hasErrnoCode(null, "ENOENT")).toBe(false);
    expect(hasErrnoCode("ENOENT", "ENOENT")).toBe(false);
  });
});

describe("pathExists", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("reports lstat presence, including a dangling symlink, and absence", async () => {
    root = await mkdtemp(join(tmpdir(), "docsfab-shared-primitives-"));
    await writeFile(join(root, "file"), "x");
    await symlink(join(root, "nowhere"), join(root, "dangling"));
    expect(await pathExists(join(root, "file"))).toBe(true);
    expect(await pathExists(join(root, "dangling"))).toBe(true);
    expect(await pathExists(join(root, "missing"))).toBe(false);
    expect(await pathExists(join(root, "file", "child"))).toBe(false);
  });
});

describe("runCliEntrypoint", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  // A real process entry exists on disk; both sides of the comparison are realpathed.
  let root = "";
  let moduleUrl = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "docsfab-entrypoint-"));
    await writeFile(join(root, "docsfab-entrypoint-probe.js"), "");
    await symlink(join(root, "docsfab-entrypoint-probe.js"), join(root, "linked-probe.js"));
    moduleUrl = pathToFileURL(join(root, "docsfab-entrypoint-probe.js")).href;
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  async function settle(): Promise<void> {
    await new Promise((resolveSettle) => setImmediate(resolveSettle));
  }

  it("does not run when another module is the process entrypoint", async () => {
    process.argv = [process.execPath, join(tmpdir(), "other.js")];
    const run = vi.fn(async () => ({ exitCode: 7 }));
    runCliEntrypoint(moduleUrl, run);
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("runs when the entrypoint argument is a symlink to this module", async () => {
    process.argv = [process.execPath, join(root, "linked-probe.js")];
    runCliEntrypoint(moduleUrl, async () => ({ exitCode: 7 }));
    await settle();
    expect(process.exitCode).toBe(7);
  });

  it("does not run when the entrypoint argument names a missing file", async () => {
    process.argv = [process.execPath, join(root, "missing.js")];
    const run = vi.fn(async () => ({ exitCode: 7 }));
    runCliEntrypoint(moduleUrl, run);
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not run without an entrypoint argument", async () => {
    process.argv = [process.execPath];
    const run = vi.fn(async () => ({ exitCode: 7 }));
    runCliEntrypoint(moduleUrl, run);
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it("sets the resolved exit code when this module is the entrypoint", async () => {
    process.argv = [process.execPath, fileURLToPath(moduleUrl)];
    runCliEntrypoint(moduleUrl, async () => ({ exitCode: 7 }));
    await settle();
    expect(process.exitCode).toBe(7);
  });

  it("leaves the exit code alone when the entry function resolves void", async () => {
    process.argv = [process.execPath, fileURLToPath(moduleUrl)];
    process.exitCode = undefined;
    runCliEntrypoint(moduleUrl, async () => undefined);
    await settle();
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a rejection through the operator envelope and exits 1", async () => {
    process.argv = [process.execPath, fileURLToPath(moduleUrl), "--json"];
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    runCliEntrypoint(moduleUrl, async () => {
      throw new Error("Probe entrypoint failed with a deliberate test error.");
    });
    await settle();
    expect(process.exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      message: "Probe entrypoint failed with a deliberate test error.",
    });
  });
});
