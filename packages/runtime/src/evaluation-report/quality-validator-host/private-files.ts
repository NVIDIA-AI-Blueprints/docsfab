// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";

import { sha256 } from "../../content-ir/canonical.js";
import { hostCheckError } from "../quality-check-rejections.js";

export async function writePrivate(path: string, bytes: Buffer): Promise<void> {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw hostCheckError("validator-workspace-not-private");
  }
}

export async function verifyRegularDigest(path: string, expected: string): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw hostCheckError("validator-input-not-regular");
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    sha256(bytes) !== expected
  ) {
    throw hostCheckError("validator-input-digest-changed");
  }
}
