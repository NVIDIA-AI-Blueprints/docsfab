// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { proveWslInteropIsolation } from "./lib/wsl-interop-probe.mjs";
import {
  installPackedDocsFab,
  parsePackedCandidateArguments,
  preparePackedCandidate,
} from "./lib/packed-cli.mjs";
import { loadLimitDefinitions } from "./check-limits.mjs";

const childBudget = loadLimitDefinitions().find((entry) => entry.name === "test.ciTimeoutMs").value;
const execute = (command, args) => promisify(execFile)(command, args, { timeout: childBudget });

export async function qualify(runtimeModule) {
  const { createLiveCommandTool } = await import(runtimeModule);
  const standard = await proveWslInteropIsolation(createLiveCommandTool);
  const aliases = await realpath(await mkdtemp(join(tmpdir(), "docsfab-wsl2-alias-")));
  try {
    const socket = await realpath(process.env.WSL_INTEROP);
    const docs = join(aliases, "docs");
    await mkdir(docs);
    const bridge = join(docs, "bridge with spaces");
    await mkdir(bridge);
    const single = join(docs, "socket-alias");
    await writeFile(single, "");
    for (const [source, target, socketAlias] of [
      ["/run/WSL", bridge, join(bridge, socket.split("/").at(-1))],
      [socket, single, single],
    ]) {
      const program = `import {proveWslInteropIsolation} from ${JSON.stringify(new URL("./lib/wsl-interop-probe.mjs", import.meta.url).href)};const {createLiveCommandTool}=await import(process.argv[1]);console.log(JSON.stringify(await proveWslInteropIsolation(createLiveCommandTool,process.argv[2],process.argv[3])));`;
      await execute("/usr/bin/bwrap", [
        "--bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--bind",
        source,
        target,
        "--",
        process.execPath,
        "--input-type=module",
        "-e",
        program,
        runtimeModule,
        socketAlias,
        aliases,
      ]);
    }
    return { standard, directoryBindAlias: "passed", socketBindAlias: "passed" };
  } finally {
    await rm(aliases, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
) {
  const { artifactDirectoryLeaf } = parsePackedCandidateArguments(process.argv.slice(2));
  if (
    process.platform !== "linux" ||
    !/microsoft.*WSL2/i.test(await readFile("/proc/sys/kernel/osrelease", "utf8"))
  )
    throw new Error(
      "WSL2 qualification requires Linux Node on a real WSL2 host; this is not a skipped success.",
    );
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-wsl2-package-")));
  try {
    const packDestination = join(root, "pack");
    await mkdir(packDestination);
    const candidate = await preparePackedCandidate({
      projectRoot,
      packDestination,
      artifactDirectoryLeaf,
      env: process.env,
    });
    const { installedPackageRoot, executable } = await installPackedDocsFab({
      tarball: candidate.tarball,
      installRoot: join(root, "install"),
      cwd: root,
      env: process.env,
    });
    await execute(executable, ["--version"]);
    const selfTest = await execute(executable, ["test", "--json"]);
    const proof = JSON.parse(selfTest.stdout);
    if (
      proof.kind !== "docsfab-offline-product-test" ||
      proof.status !== "passed" ||
      proof.isolation.sourceCheckout !== "unchanged" ||
      proof.isolation.credentials !== "not-used" ||
      proof.isolation.network !== "not-used"
    )
      throw new Error("Installed CLI self-test did not succeed.");
    const runtimeModule = pathToFileURL(
      join(installedPackageRoot, "dist/live-agent/command-tool.js"),
    ).href;
    console.log(
      JSON.stringify(
        {
          installedPackage: "passed",
          candidate: {
            name: candidate.record.name,
            version: candidate.record.version,
            sourceRevision: candidate.sourceRevision,
            integrity: candidate.integrity,
            origin: candidate.origin,
          },
          ...(await qualify(runtimeModule)),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
