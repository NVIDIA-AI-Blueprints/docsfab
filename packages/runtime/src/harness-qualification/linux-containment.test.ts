// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../contract-kit/index.js";
import { createLocalHarnessQualificationHost } from "./adapters.js";
import { runBoundedProcess } from "./bounded-process.js";
import {
  LINUX_QUALIFICATION_BWRAP,
  linuxQualificationCommandPrefix,
  proveLinuxDescendantContainment,
  runContainedLinuxBoundedProcess,
} from "./linux-containment.js";
import {
  bindQualificationStagingManifest,
  createLinuxContainedHarnessQualificationHost,
} from "./linux-qualification-host.js";

const linux = process.platform === "linux";
const LINUX_TIMEOUT_MS = 20_000;

const roots: string[] = [];

function trustedRoot(): string {
  const root = process.env.TMPDIR || tmpdir();
  if (!root.startsWith("/")) {
    throw new Error("DocsFab qualification probes require an absolute trusted temp root.");
  }
  return root;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(trustedRoot(), "docsfab-hq-test-"));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const ISOLATION_SCRIPT = [
  "const fs=require('node:fs');",
  "const [staging,hostWrite,childWrite]=process.argv.slice(1);",
  "const parts=[];",
  "try{fs.readFileSync(staging);parts.push('staging-read')}catch{parts.push('staging-denied')}",
  "try{fs.writeFileSync(hostWrite,'x');parts.push('host-write')}catch{parts.push('host-denied')}",
  "try{fs.writeFileSync(childWrite,'ok');parts.push('child-write')}catch{parts.push('child-denied')}",
  "process.stdout.write(parts.join(',')+'\\n');",
].join("");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("contained Linux harness qualification host", () => {
  it("keeps the fail-closed runner from spawning when containment is unproven", async () => {
    const result = await runBoundedProcess({
      executablePath: process.execPath,
      arguments: ["-e", 'throw new Error("must not spawn")'],
      workingDirectory: tmpdir(),
      environment: {},
      stdin: Buffer.from("private input"),
      timeoutMs: 5_000,
      maxStdoutBytes: 64,
      maxStderrBytes: 64,
    });
    expect(result.status).toBe("unsupported-confinement");
    expect(result.stdinDelivered).toBe(false);
    expect(result.descendantContainment).toBe("unsupported");
  });

  it("keeps the default local host fail-closed before executable inspection", async () => {
    const host = createLocalHarnessQualificationHost();
    expect(await host.descendantContainment(new AbortController().signal)).toBe("unsupported");
  });

  it.skipIf(linux)(
    "does not fake Linux success on Darwin and fail-closes before spawn",
    async () => {
      const result = await runContainedLinuxBoundedProcess({
        executablePath: process.execPath,
        arguments: ["-e", 'throw new Error("must not spawn")'],
        workingDirectory: tmpdir(),
        environment: { HOME: tmpdir(), LANG: "C", LC_ALL: "C", TMPDIR: tmpdir() },
        stdin: Buffer.from("private input"),
        timeoutMs: 5_000,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
      });
      expect(result.status).toBe("unsupported-confinement");
      expect(result.stdinDelivered).toBe(false);
      expect(result.stdinBytes).toBe(0);
      expect(result.descendantContainment).toBe("unsupported");
    },
  );

  it("records fail-before-spawn from the Linux host factory on Darwin", async () => {
    const host = createLinuxContainedHarnessQualificationHost();
    if (process.platform === "darwin") {
      expect(host.platform().os).toBe("darwin");
      expect(await host.descendantContainment(new AbortController().signal)).toBe("unsupported");
      const result = await host.runProcess({
        executablePath: process.execPath,
        arguments: ["-e", 'throw new Error("must not spawn")'],
        workingDirectory: tmpdir(),
        environment: { HOME: tmpdir(), LANG: "C", LC_ALL: "C", TMPDIR: tmpdir() },
        stdin: Buffer.alloc(0),
        timeoutMs: 1_000,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
      });
      expect(result.status).toBe("unsupported-confinement");
      expect(result.descendantContainment).toBe("unsupported");
    }
  });

  it("pins a PID-namespace prefix that omits host staging and does not unshare the provider network", () => {
    const workingDirectory = "/tmp/docsfab-hq-child";
    const staging = "/tmp/docsfab-hq-staging/secret";
    const prefix = linuxQualificationCommandPrefix({
      executablePath: process.execPath,
      workingDirectory,
    });
    expect(prefix[0]).toBe("--unshare-pid");
    expect(prefix).toContain("--die-with-parent");
    expect(prefix).toContain("--new-session");
    expect(prefix).not.toContain("--unshare-net");
    expect(prefix.join("\0")).not.toContain(staging);
    expect(prefix.at(-1)).toBe("--");
    expect(LINUX_QUALIFICATION_BWRAP).toBe("/usr/bin/bwrap");
  });

  it("rejects credentials and extra environment names before a Linux spawn", async () => {
    await expect(
      runContainedLinuxBoundedProcess({
        executablePath: process.execPath,
        arguments: ["-e", "process.exit(0)"],
        workingDirectory: tmpdir(),
        environment: {
          HOME: tmpdir(),
          LANG: "C",
          LC_ALL: "C",
          TMPDIR: tmpdir(),
          NODE_OPTIONS: "--require /tmp/injected",
        },
        stdin: Buffer.alloc(0),
        timeoutMs: 1_000,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
      }),
    ).rejects.toThrow("invalid values");
    await expect(
      runContainedLinuxBoundedProcess({
        executablePath: process.execPath,
        arguments: ["-e", "process.exit(0)"],
        workingDirectory: tmpdir(),
        environment: { HOME: tmpdir(), LANG: "C", LC_ALL: "C", TMPDIR: tmpdir() },
        stdin: Buffer.from("-----BEGIN PRIVATE KEY-----"),
        timeoutMs: 1_000,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
      }),
    ).rejects.toThrow("invalid values");
  });

  it.skipIf(!linux)(
    "proves PID teardown so a detached grandchild cannot outlive the namespace",
    async () => {
      const scratch = await tempRoot();
      const containment = await proveLinuxDescendantContainment(scratch);
      if (containment !== "verified") {
        expect(containment).toBe("unsupported");
        return;
      }
      await expect(readFile(join(scratch, "escaped-descendant"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    LINUX_TIMEOUT_MS,
  );

  it.skipIf(!linux)(
    "runs a contained child that cannot read staging, write the host, or skip the empty child root",
    async () => {
      const root = await tempRoot();
      const child = join(root, "child");
      const staging = join(root, "staging");
      const hostOnly = join(root, "host");
      await mkdir(child, { mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      await mkdir(hostOnly, { mode: 0o700 });
      const stagingFile = join(staging, "prompt");
      const hostWrite = join(hostOnly, "escape");
      const childWrite = join(child, "allowed");
      await writeFile(stagingFile, "oracle-secret\n", { mode: 0o600 });
      const result = await runContainedLinuxBoundedProcess({
        executablePath: process.execPath,
        arguments: ["-e", ISOLATION_SCRIPT, stagingFile, hostWrite, childWrite],
        workingDirectory: child,
        environment: { HOME: child, LANG: "C", LC_ALL: "C", TMPDIR: child },
        stdin: Buffer.from("task"),
        timeoutMs: 8_000,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
      });
      if (result.status === "unsupported-confinement") {
        expect(result.descendantContainment).toBe("unsupported");
        return;
      }
      expect(result.status).toBe("settled");
      expect(result.exitCode).toBe(0);
      expect(result.descendantContainment).toBe("verified");
      expect(result.stdinDelivered).toBe(true);
      expect(result.stdout.toString("utf8").trim()).toBe("staging-denied,host-denied,child-write");
      await expect(readFile(hostWrite)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(childWrite, "utf8")).toBe("ok");
      expect(await readFile(stagingFile, "utf8")).toBe("oracle-secret\n");
    },
    LINUX_TIMEOUT_MS,
  );

  it.skipIf(!linux)(
    "opens host-only staging and an empty owner-only child workspace after containment",
    async () => {
      const root = await tempRoot();
      const child = join(root, "child");
      const staging = join(root, "staging");
      await mkdir(child, { mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      const prompt = Buffer.from("Review only the supplied candidate.\n");
      const outputSchema = {
        type: "object",
        additionalProperties: false,
        required: ["decision"],
        properties: { decision: { type: "string", enum: ["pass"] } },
      };
      const outputSchemaJson = Buffer.from(`${JSON.stringify(outputSchema)}\n`);
      const bound = {
        corpusManifestSha256: sha256("corpus"),
        caseSha256: sha256("case"),
        workflowSha256: sha256("workflow"),
        skillSha256: sha256("skill"),
        qualitySha256: sha256("quality"),
        outputSchemaSha256: canonicalDigest(outputSchema),
        thresholdsSha256: sha256("thresholds"),
        scorerSha256: sha256("scorer"),
        promptSha256: sha256(prompt),
      };
      const inputDigests = {
        ...bound,
        stagingManifestSha256: bindQualificationStagingManifest({
          prompt,
          outputSchemaJson,
          inputDigests: bound,
        }),
      };
      await writeFile(join(staging, "prompt"), prompt, { mode: 0o600 });
      await writeFile(join(staging, "output-schema.json"), outputSchemaJson, { mode: 0o600 });
      await writeFile(join(staging, "input-digests.json"), `${JSON.stringify(inputDigests)}\n`, {
        mode: 0o600,
      });
      const host = createLinuxContainedHarnessQualificationHost();
      const signal = new AbortController().signal;
      const containment = await host.descendantContainment(signal);
      if (containment !== "verified") {
        expect(containment).toBe("unsupported");
        return;
      }
      const workspace = await host.workspaceManifest(child, signal);
      expect(workspace.empty).toBe(true);
      expect(workspace.ownerOnly).toBe(true);
      const opened = await host.openVerifiedStaging(staging, signal);
      expect(opened.trusted).toBe(true);
      expect(opened.prompt.equals(prompt)).toBe(true);
      const executable = await host.inspectExecutable(process.execPath, signal);
      expect(executable.basename.length).toBeGreaterThan(0);
      expect(executable.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const probe = await host.toolDenialProbe(
        {
          bindingSha256: "a".repeat(64),
          executablePath: process.execPath,
          executable,
          arguments: ["--tools", ""],
          workingDirectory: child,
          environment: { HOME: child, LANG: "C", LC_ALL: "C", TMPDIR: child },
          platform: host.platform(),
          policySha256: "b".repeat(64),
        },
        signal,
      );
      expect(probe.status).toBe("unsupported");
    },
    LINUX_TIMEOUT_MS,
  );
});
