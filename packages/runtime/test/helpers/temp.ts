// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-cleaned temporary directories for runtime tests.
 *
 * Call {@link temporaryRoots} once at module or `describe` scope; every
 * directory it creates or tracks is removed after each test. When teardown order
 * matters, call `cleanup()` from your own `afterEach`; the registered hook is
 * then a no-op.
 */
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

export interface TemporaryRootOptions {
  /**
   * Explicit `chmod` after creation, for callers whose store refuses a root
   * readable by group or other (for example `0o700`).
   */
  readonly mode?: number;
  /**
   * Return the canonical path (macOS `/var` -> `/private/var`) for tests that
   * compare against resolved or reported paths.
   */
  readonly realpath?: boolean;
}

export interface TemporaryRoots {
  /** Create a fresh directory named `<os tmpdir>/<prefix>XXXXXX`, removed after the current test. */
  create(prefix: string, options?: TemporaryRootOptions): Promise<string>;
  /** Adopt an externally created path so it is removed after the current test. */
  track<T extends string>(path: T): T;
  /** Remove every created or tracked path now. Idempotent. */
  cleanup(): Promise<void>;
}

export function temporaryRoots(): TemporaryRoots {
  const paths: string[] = [];
  const roots: TemporaryRoots = {
    async create(prefix, options = {}) {
      const created = await mkdtemp(join(tmpdir(), prefix));
      paths.push(created);
      if (options.mode !== undefined) await chmod(created, options.mode);
      return options.realpath ? await realpath(created) : created;
    },
    track(path) {
      paths.push(path);
      return path;
    },
    async cleanup() {
      await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    },
  };
  afterEach(() => roots.cleanup());
  return roots;
}
