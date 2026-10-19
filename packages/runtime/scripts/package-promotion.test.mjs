// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertMainPromotionAllowed,
  readChannel,
  readChannelWithRetry,
} from "./lib/package-promotion.mjs";
import { resolvePublishChannel } from "./publish-package.mjs";

const execute = promisify(execFile);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const roots = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function archiveFor(revision) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-promotion-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    join(packageRoot, "dist", "build-identity.js"),
    `export const DOCSFAB_BUILD_IDENTITY = Object.freeze(${JSON.stringify({ schemaVersion: 1, commit: revision, dirty: false })});\n`,
  );
  const path = join(root, "archive.tgz");
  await execute("tar", ["-czf", path, "-C", root, "package"]);
  return { path };
}

function admission({ candidate, head, winner, ancestry, winnerVersion, archiveRevision }) {
  const calls = [];
  const archiveReads = [];
  const run = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "fetch") return { stdout: "", stderr: "" };
    if (command === "git" && args[0] === "rev-parse") return { stdout: `${head}\n`, stderr: "" };
    if (command === "git" && args[0] === "merge-base") {
      if (ancestry.has(`${args[2]}:${args[3]}`)) return { stdout: "", stderr: "" };
      const error = new Error("not ancestor");
      error.code = 1;
      throw error;
    }
    return execute(command, args, options);
  };
  const observedVersion =
    winnerVersion ?? (winner ? `0.1.0-main.${winner.slice(0, 8)}` : undefined);
  return {
    calls,
    archiveReads,
    run,
    input: {
      observedVersion,
      target: { version: `0.1.0-main.${candidate.slice(0, 8)}`, distTag: "main" },
      packageJson: { name: "docsfab", version: "0.1.0" },
      registry: "https://registry.example.invalid/project/npm/",
      env: { CI_DEFAULT_BRANCH: "main" },
      run,
      workRoot: "/tmp/promotion-test",
      candidateSourceRevision: candidate,
      ancestryDepth: { value: 5000 },
      readVersionArchive: async (request) => {
        archiveReads.push(request);
        return archiveFor(archiveRevision ?? winner);
      },
      runWithOutputBound: (runner, command, args, options) => runner(command, args, options),
      fail: (message) => {
        const error = new Error(message);
        error.reasonClass = message.startsWith("channel-superseded")
          ? "superseded"
          : "ancestry_unknown";
        throw error;
      },
    },
    ancestry,
  };
}

describe("main package promotion ancestry admission", () => {
  it("admits an eligible ancestor when protected HEAD has advanced", async () => {
    const graph = new Set([`${A}:${B}`, `${B}:${C}`]);
    const test = admission({ candidate: B, head: C, winner: A, ancestry: graph });
    await expect(assertMainPromotionAllowed(test.input)).resolves.toBeUndefined();
    expect(test.calls.some((call) => call[1] === "fetch")).toBe(true);
  });

  it("marks an older reverse-completion candidate superseded by the newer winner", async () => {
    const graph = new Set([`${A}:${B}`, `${A}:${C}`]);
    const test = admission({ candidate: A, head: C, winner: B, ancestry: graph });
    await expect(assertMainPromotionAllowed(test.input)).rejects.toMatchObject({
      reasonClass: "superseded",
      message: expect.stringMatching(/channel-superseded/u),
    });
  });

  it("refuses a divergent current winner", async () => {
    const test = admission({ candidate: B, head: C, winner: A, ancestry: new Set([`${B}:${C}`]) });
    await expect(assertMainPromotionAllowed(test.input)).rejects.toThrow(
      /channel-ancestry-unknown/u,
    );
  });

  it("refuses a candidate outside the fetched protected graph", async () => {
    const test = admission({ candidate: B, head: C, winner: undefined, ancestry: new Set() });
    await expect(assertMainPromotionAllowed(test.input)).rejects.toThrow(
      /channel-candidate-ineligible/u,
    );
  });

  it("admits an authenticated older-base winner whose source is the candidate ancestor", async () => {
    const test = admission({
      candidate: B,
      head: C,
      winner: A,
      winnerVersion: `0.0.9-main.${A.slice(0, 8)}`,
      ancestry: new Set([`${B}:${C}`, `${A}:${B}`]),
    });
    await expect(assertMainPromotionAllowed(test.input)).resolves.toBeUndefined();
  });

  it("admits an authenticated older main winner with selector-produced build metadata", async () => {
    const winnerTarget = resolvePublishChannel(
      { version: "0.0.9+build.7" },
      {
        CI_COMMIT_BRANCH: "main",
        CI_DEFAULT_BRANCH: "main",
        CI_COMMIT_SHORT_SHA: A.slice(0, 8),
      },
    );
    expect(winnerTarget.version).toBe(`0.0.9+build.7-main.${A.slice(0, 8)}`);
    const test = admission({
      candidate: B,
      head: C,
      winner: A,
      winnerVersion: winnerTarget.version,
      ancestry: new Set([`${B}:${C}`, `${A}:${B}`]),
    });
    await expect(assertMainPromotionAllowed(test.input)).resolves.toBeUndefined();
    expect(test.archiveReads).toHaveLength(1);
    expect(test.archiveReads[0].version).toBe(winnerTarget.version);
  });

  it.each([
    `npm:other@0.0.9-main.${A.slice(0, 8)}`,
    `../0.0.9-main.${A.slice(0, 8)}`,
    `0.0.9-rc.1-main.${A.slice(0, 8)}`,
    `0.0.9+build..7-main.${A.slice(0, 8)}`,
  ])("refuses malformed main winner %s before archive readback", async (winnerVersion) => {
    const test = admission({
      candidate: B,
      head: C,
      winner: A,
      winnerVersion,
      ancestry: new Set([`${B}:${C}`, `${A}:${B}`]),
    });
    await expect(assertMainPromotionAllowed(test.input)).rejects.toThrow(
      /channel-ancestry-unknown: current main channel version is not an admitted main version/u,
    );
    expect(test.archiveReads).toHaveLength(0);
  });

  it("refuses a cross-base winner whose source is newer than the candidate", async () => {
    const test = admission({
      candidate: A,
      head: C,
      winner: B,
      winnerVersion: `0.0.9-main.${B.slice(0, 8)}`,
      ancestry: new Set([`${A}:${C}`, `${A}:${B}`]),
    });
    await expect(assertMainPromotionAllowed(test.input)).rejects.toMatchObject({
      reasonClass: "superseded",
      message: expect.stringMatching(/channel-superseded/u),
    });
  });

  it("admits a newer candidate source even when its package base is lower", async () => {
    const test = admission({
      candidate: B,
      head: C,
      winner: A,
      winnerVersion: `0.2.0-main.${A.slice(0, 8)}`,
      ancestry: new Set([`${B}:${C}`, `${A}:${B}`]),
    });
    await expect(assertMainPromotionAllowed(test.input)).resolves.toBeUndefined();
  });

  it("refuses a divergent cross-base winner", async () => {
    const test = admission({
      candidate: B,
      head: C,
      winner: A,
      winnerVersion: `0.0.9-main.${A.slice(0, 8)}`,
      ancestry: new Set([`${B}:${C}`]),
    });
    await expect(assertMainPromotionAllowed(test.input)).rejects.toThrow(
      /channel-ancestry-unknown: current channel source is divergent/u,
    );
  });

  it("refuses a cross-base winner whose version disagrees with its archive identity", async () => {
    const test = admission({
      candidate: B,
      head: C,
      winner: A,
      winnerVersion: `0.0.9-main.${A.slice(0, 8)}`,
      archiveRevision: C,
      ancestry: new Set([`${B}:${C}`, `${A}:${B}`]),
    });
    await expect(assertMainPromotionAllowed(test.input)).rejects.toThrow(
      /channel-ancestry-unknown: current channel version does not match its archive source identity/u,
    );
  });
});

const READBACK_TARGET = { version: "0.1.0-main.436f9314", distTag: "main" };

function channelRead(fetchImpl, timeoutMs, target = READBACK_TARGET) {
  return readChannel({
    name: "docsfab",
    target,
    registry: "https://registry.example.invalid/api/v4/projects/1/packages/npm/",
    env: { CI_JOB_TOKEN: "test-token" },
    fetchImpl,
    context: "channel promotion",
    timeoutMs,
  });
}

describe("dedicated channel endpoint readback", () => {
  it("confirms a selector-produced main version with build metadata", async () => {
    const target = resolvePublishChannel(
      { version: "0.0.9+build.7" },
      {
        CI_COMMIT_BRANCH: "main",
        CI_DEFAULT_BRANCH: "main",
        CI_COMMIT_SHORT_SHA: A.slice(0, 8),
      },
    );
    const observed = await channelRead(
      async () => Response.json({ main: target.version }),
      500,
      target,
    );
    expect(observed).toBe(`0.0.9+build.7-main.${A.slice(0, 8)}`);

    await expect(
      channelRead(
        async () => Response.json({ main: `0.0.9+build..7-main.${A.slice(0, 8)}` }),
        500,
        target,
      ),
    ).rejects.toMatchObject({ reasonClass: "malformed" });
    await expect(
      channelRead(async () => Response.json({ main: "0.0.9" }), 500, target),
    ).rejects.toMatchObject({ reasonClass: "channel_mismatch" });
  });

  it("retries a bounded quiet response and accepts the next channel read", async () => {
    let reads = 0;
    const fetchImpl = () => {
      reads += 1;
      if (reads === 1) return new Promise(() => {});
      return Promise.resolve(Response.json({ main: READBACK_TARGET.version }));
    };
    const result = await readChannelWithRetry({
      read: () => channelRead(fetchImpl, 75),
      attempts: 2,
      delayMs: 1,
      wait: async () => {},
    });
    expect(result).toEqual({ observedVersion: READBACK_TARGET.version, attempts: 2 });
    expect(reads).toBe(2);
  });

  it("aborts a quiet endpoint at its owned deadline", async () => {
    let observedSignal;
    await expect(
      channelRead((_url, options) => {
        observedSignal = options.signal;
        return new Promise(() => {});
      }, 75),
    ).rejects.toMatchObject({ reasonClass: "timeout" });
    expect(observedSignal.aborted).toBe(true);
  });

  it("refuses authorization and redirects without following credentials", async () => {
    await expect(
      channelRead(async () => new Response(null, { status: 403 }), 500),
    ).rejects.toMatchObject({ reasonClass: "authorization" });
    await expect(
      channelRead(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://elsewhere.invalid/" },
          }),
        500,
      ),
    ).rejects.toMatchObject({ reasonClass: "malformed" });
  });

  it("keeps a declared response overflow distinct from a deadline", async () => {
    const catalog = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        new URL("../../../config/limits.catalog.json", import.meta.url),
        "utf8",
      ),
    );
    const above = catalog.limits["publishPackage.commandOutputBytes"].value + 1;
    await expect(
      channelRead(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(above) },
          }),
        500,
      ),
    ).rejects.toMatchObject({ reasonClass: "output_bound" });
  });
});
