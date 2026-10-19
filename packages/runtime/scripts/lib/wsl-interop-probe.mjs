// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadLimitDefinitions } from "../check-limits.mjs";

const childBudget = loadLimitDefinitions().find((entry) => entry.name === "test.ciTimeoutMs").value;
const execute = (command, args, options = {}) =>
  promisify(execFile)(command, args, { ...options, timeout: childBudget });
const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const cmd = "/mnt/c/Windows/System32/cmd.exe";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const encoded = (program) => Buffer.from(program, "utf16le").toString("base64");

/** Real Windows controls; only the two owned sentinels are ever changed. */
export async function proveWslInteropIsolation(createTool, socketOverride, rootOverride) {
  assert.equal(process.platform, "linux", "WSL2 qualification requires Linux Node");
  assert.match(
    await readFile("/proc/sys/kernel/osrelease", "utf8"),
    /microsoft.*WSL2/i,
    "WSL2 qualification requires a real WSL2 kernel",
  );
  const sockets = await readdir("/run/WSL");
  const socket =
    socketOverride ??
    (await realpath(
      process.env.WSL_INTEROP ??
        join("/run/WSL", sockets.find((name) => name.endsWith("_interop")) ?? "missing"),
    ));
  const root =
    rootOverride ?? (await realpath(await mkdtemp(join(tmpdir(), "docsfab-wsl2-probe-"))));
  let windowsRoot;
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true, mode: 0o700 });
    const source = join(root, "src", "protected.ts");
    const guide = join(root, "docs", "guide.md");
    await writeFile(guide, "Guide\n");
    await writeFile(source, "baseline\n");
    const { stdout: windowsTemp } = await execute(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded("[System.IO.Path]::GetTempPath()"),
    ]);
    const { stdout: linuxTemp } = await execute("wslpath", ["-u", windowsTemp.trim()]);
    windowsRoot = await mkdtemp(join(linuxTemp.trim(), "docsfab-wsl2-probe-"));
    const sentinel = join(windowsRoot, "outside.txt");
    const { stdout: windowsSentinel } = await execute("wslpath", ["-w", sentinel]);
    const { stdout: uncSource } = await execute("wslpath", ["-w", source]);
    const write = (path) =>
      `[System.IO.File]::WriteAllText('${path.trim().replaceAll("'", "''")}','escaped')`;
    const childProgram = `${write(windowsSentinel)};${write(uncSource)}`;
    const program = `Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded(childProgram)}' -Wait`;
    // Prove that this exact bridge, UNC path, and Windows child can write before testing refusal.
    await execute(
      powershell,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(program)],
      { env: { ...process.env, WSL_INTEROP: socket } },
    );
    assert.equal(await readFile(source, "utf8"), "escaped", "Windows UNC positive control failed");
    assert.equal(
      await readFile(sentinel, "utf8"),
      "escaped",
      "Windows child positive control failed",
    );
    const tool = createTool({
      repositoryPath: root,
      allowWrite: true,
      confirm: async () => true,
      environment: { ...process.env, DOCSFAB_CONFIG_ROOT: join(root, "config") },
    });
    const invoke = (command) =>
      tool.execute("wsl2-qualification", { command }, undefined, undefined, {});
    const reset = async () => {
      await writeFile(source, "baseline\n");
      await writeFile(sentinel, "baseline\n");
    };
    await reset();
    assert.equal((await invoke("printf allowed >> docs/guide.md")).details.status, "succeeded");
    assert.equal(
      await readFile(guide, "utf8"),
      "Guide\nallowed",
      "Allowed documentation write failed",
    );
    assert.equal(
      (await invoke("test ! -s /init && printf WSL_INTERPRETER_HIDDEN")).details.status,
      "succeeded",
      "WSL interpreter remained readable",
    );
    const denied = await invoke("printf denied > src/protected.ts");
    assert.equal(denied.details.status, "failed");
    assert.match(
      JSON.stringify(denied.content),
      /Read-only file system|Permission denied/,
      "Linux source write must fail at the filesystem boundary",
    );
    const socketProbe = `const net=require('node:net');const s=net.connect(process.argv[1]);s.on('connect',()=>{console.log('WSL_SOCKET_EXPOSED');process.exit(1)});s.on('error',e=>{if(!['ENOENT','ENOTDIR','EACCES','ENOTSOCK','ECONNREFUSED'].includes(e.code))throw e;console.log('WSL_SOCKET_DENIED')})`;
    const connection = await invoke(
      `${quote(process.execPath)} -e ${quote(socketProbe)} ${quote(socket)}`,
    );
    assert.equal(connection.details.status, "succeeded", "WSL interop socket remained connectable");
    assert.match(JSON.stringify(connection.content), /WSL_SOCKET_DENIED/);
    for (const [name, command] of [
      ["cmd-explicit-socket", `${cmd} /d /c ${quote("echo escaped>" + windowsSentinel.trim())}`],
      [
        "powershell-unc-and-child",
        `${powershell} -NoProfile -NonInteractive -EncodedCommand ${encoded(program)}`,
      ],
    ]) {
      await reset();
      const result = await invoke(`WSL_INTEROP=${quote(socket)} ${command}`);
      assert.equal(result.details.status, "failed", `${name}: Windows execution escaped isolation`);
      assert.match(
        JSON.stringify(result.content),
        /WSL|Permission denied|Exec format error|cannot execute/,
        `${name}: failure must identify bridge execution`,
      );
      assert.equal(
        await readFile(source, "utf8"),
        "baseline\n",
        `${name}: protected Linux source changed`,
      );
      assert.equal(
        await readFile(sentinel, "utf8"),
        "baseline\n",
        `${name}: outside Windows sentinel changed`,
      );
    }
    return {
      documentationWrite: "passed",
      linuxSourceDenial: "passed",
      socketCut: "passed",
      explicitSocketCmd: "passed",
      uncAndWindowsChild: "passed",
      positiveWindowsControls: "passed",
    };
  } finally {
    // An outer namespace owns alias fixtures; never remove a live bridge bind mount recursively.
    if (!rootOverride) await rm(root, { recursive: true, force: true });
    if (windowsRoot) await rm(windowsRoot, { recursive: true, force: true });
  }
}
