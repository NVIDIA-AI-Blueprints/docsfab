// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Linux Bubblewrap admission probe decides on outbound connectivity, not on
 * private loopback (#2332). `bwrap --unshare-net` always brings up `lo`, so a
 * probe that refuses whenever it can listen on 127.0.0.1 refuses every host.
 *
 * The decision cases run the real probe script that admission sends, through
 * the real `admitLinuxBubblewrapValidationBackend`, with only the outbound
 * connect outcome fixed by a preload; the probe's filesystem checks see real
 * permission bits. The last case runs the real Bubblewrap on Linux.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  admitLinuxBubblewrapValidationBackend,
  bindLiveValidationBackendRequest,
} from "../src/delivery/worktree/validate.js";
import { issueHostSelectedValidationBackend } from "../src/delivery/worktree/validation-backend.js";
import {
  ExecFileDeliveryCommandRunner,
  type DeliveryCommandRunner,
} from "../src/delivery/worktree/types.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const restore: string[] = [];

afterEach(async () => {
  // Undo the permission bits that deny the probe, then remove the roots.
  await Promise.all(restore.splice(0).map((path) => chmod(path, 0o700)));
  await roots.cleanup();
});

/** Permission bits do not bind root, so the filesystem denials need a non-root user. */
const nonRoot = typeof process.getuid === "function" && process.getuid() !== 0;

/**
 * The candidate mounts a fresh /tmp after its binds, so a fixture under /tmp
 * is hidden inside the sandbox (#2358). CI runs with TMPDIR outside /tmp.
 */
const fixtureOutsideTmp = (() => {
  const path = relative("/tmp", resolve(tmpdir()));
  return path.startsWith("..") || path.startsWith("/");
})();

async function admissionFixture(options: { deniedReadable?: boolean } = {}) {
  const root = await roots.create("docsfab-admission-probe-");
  const worktreePath = join(root, "worktree");
  const scratchPath = join(root, "scratch");
  const deniedRoot = join(root, "denied");
  await mkdir(worktreePath);
  await mkdir(scratchPath);
  await mkdir(deniedRoot);
  await writeFile(join(worktreePath, "README.md"), "candidate tree\n");
  const deniedPath = join(deniedRoot, "secret");
  await writeFile(deniedPath, "host-only\n", { mode: 0o600 });
  const host = {
    worktreePath,
    scratchPath,
    deniedReadPaths: [deniedPath],
    deniedReadRoots: [deniedRoot],
  };
  const request = await bindLiveValidationBackendRequest(host);
  return { root, host, request, worktreePath, deniedPath, deniedReadable: options.deniedReadable };
}

/** Deny what the sandbox would deny: reading the host path and writing the candidate. */
async function denyLikeTheSandbox(fixture: Awaited<ReturnType<typeof admissionFixture>>) {
  restore.push(fixture.worktreePath);
  await chmod(fixture.worktreePath, 0o555);
  if (!fixture.deniedReadable) {
    restore.push(fixture.deniedPath);
    await chmod(fixture.deniedPath, 0o000);
  }
}

/** Fix the outbound connect outcome; listening on loopback stays real. */
async function outboundPreload(root: string, outcome: "unreachable" | "connected") {
  const path = join(root, `outbound-${outcome}.cjs`);
  await writeFile(
    path,
    [
      "const net = require('node:net');",
      "const { EventEmitter } = require('node:events');",
      "const connect = () => {",
      "  const socket = new EventEmitter();",
      "  socket.setTimeout = () => socket;",
      "  socket.destroy = () => socket;",
      "  process.nextTick(() => {",
      `    if (${JSON.stringify(outcome)} === 'connected') socket.emit('connect');`,
      "    else socket.emit('error', Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }));",
      "  });",
      "  return socket;",
      "};",
      "net.connect = connect;",
      "net.createConnection = connect;",
    ].join("\n"),
  );
  return path;
}

/**
 * Runs the command admission sends to Bubblewrap without the sandbox: the probe
 * script after `--`, under the preload. Records the candidate it was given.
 */
function probeRunner(preload: string, calls: string[][]): DeliveryCommandRunner {
  const delegate = new ExecFileDeliveryCommandRunner();
  return {
    run: async (command, args, cwd, options) => {
      calls.push([command, ...args]);
      const separator = args.indexOf("--");
      const inner = args.slice(separator + 1);
      const executable = inner[0];
      if (command !== "/usr/bin/bwrap" || separator < 0 || executable !== process.execPath) {
        throw new Error("admission sent an unexpected command");
      }
      return delegate.run(executable, ["--require", preload, ...inner.slice(1)], cwd, options);
    },
  };
}

describe("Linux Bubblewrap admission probe (#2332)", () => {
  it.runIf(nonRoot)(
    "admits the candidate when outbound connect fails even though loopback listens",
    async () => {
      const fixture = await admissionFixture();
      const preload = await outboundPreload(fixture.root, "unreachable");
      await denyLikeTheSandbox(fixture);
      const calls: string[][] = [];
      const admitted = await admitLinuxBubblewrapValidationBackend(
        issueHostSelectedValidationBackend("linux")!,
        fixture.request,
        fixture.host,
        probeRunner(preload, calls),
        fixture.worktreePath,
      );
      expect(admitted.attestation.backendIdentity).toBe("linux-bubblewrap");
      expect(admitted.isolation.commandPrefix).toContain("--unshare-net");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("--unshare-net");
    },
  );

  it.runIf(nonRoot)("refuses the candidate when the outbound probe connects", async () => {
    const fixture = await admissionFixture();
    const preload = await outboundPreload(fixture.root, "connected");
    await denyLikeTheSandbox(fixture);
    await expect(
      admitLinuxBubblewrapValidationBackend(
        issueHostSelectedValidationBackend("linux")!,
        fixture.request,
        fixture.host,
        probeRunner(preload, []),
        fixture.worktreePath,
      ),
    ).rejects.toMatchObject({ code: "backend-unavailable" });
  });

  it.runIf(nonRoot)(
    "refuses the candidate when a denied host path is readable, even with no outbound access",
    async () => {
      const fixture = await admissionFixture({ deniedReadable: true });
      const preload = await outboundPreload(fixture.root, "unreachable");
      await denyLikeTheSandbox(fixture);
      await expect(
        admitLinuxBubblewrapValidationBackend(
          issueHostSelectedValidationBackend("linux")!,
          fixture.request,
          fixture.host,
          probeRunner(preload, []),
          fixture.worktreePath,
        ),
      ).rejects.toMatchObject({ code: "backend-unavailable" });
    },
  );

  // Real Bubblewrap: `--unshare-net` keeps loopback up and blocks outbound.
  it.runIf(process.platform === "linux" && fixtureOutsideTmp)(
    "admits the real Bubblewrap candidate on Linux",
    async () => {
      const fixture = await admissionFixture();
      const admitted = await admitLinuxBubblewrapValidationBackend(
        issueHostSelectedValidationBackend("linux")!,
        fixture.request,
        fixture.host,
        new ExecFileDeliveryCommandRunner(),
        fixture.worktreePath,
      );
      expect(admitted.attestation.backendIdentity).toBe("linux-bubblewrap");
    },
  );
});
