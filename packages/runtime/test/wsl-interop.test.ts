// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryRoots } from "./helpers/temp.js";
import { createLiveCommandTool } from "../src/live-agent/command-tool.js";
import { wslInteropMounts, WSL_INTEROP_FAILURE } from "../src/live-agent/wsl-interop.js";

const host = vi.hoisted(() => ({
  absent: false,
  error: "",
  mountinfo: "",
  links: 1,
  outsideLink: false,
  owner: 0,
  mode: 0o755,
}));
const directory = {
  dev: 1,
  ino: 2,
  uid: 0,
  mode: 0o755,
  nlink: 1,
  isDirectory: () => true,
  isFile: () => false,
  isSocket: () => false,
  isSymbolicLink: () => false,
};
const socket = { ...directory, ino: 3, isDirectory: () => false, isSocket: () => true };
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const failure = (code: string) => Object.assign(new Error(code), { code });
  const lookup = (path: string) => {
    if (path === "/run/WSL") {
      if (host.absent) throw failure("ENOENT");
      if (host.error) throw failure(host.error);
      return { ...directory, uid: host.owner, mode: host.mode };
    }
    if (["/alias with spaces", "/run/WSL"].includes(path)) return directory;
    if (["/run/WSL/2_interop", "/socket-alias"].includes(path))
      return { ...socket, nlink: host.links };
    if (path === "/init") throw failure("ENOENT");
    if (path === "/") return { ...directory, ino: 1 };
    return undefined;
  };
  return {
    ...actual,
    lstat: async (path: string, ...args: unknown[]) =>
      lookup(String(path)) ?? actual.lstat(path, ...(args as [])),
    stat: async (path: string, ...args: unknown[]) =>
      lookup(String(path)) ?? actual.stat(path, ...(args as [])),
    realpath: async (path: string, ...args: unknown[]) => {
      if (path === "/run/WSL" || path === "/run/WSL/2_interop") {
        lookup(path);
        return path;
      }
      if (path === "/run/WSL/1_interop")
        return host.outsideLink ? "/outside/socket" : "/run/WSL/2_interop";
      return actual.realpath(path, ...(args as []));
    },
    readdir: async (path: string, ...args: unknown[]) =>
      path === "/run/WSL" ? ["1_interop", "2_interop"] : actual.readdir(path, ...(args as [])),
    readFile: async (path: string, ...args: unknown[]) =>
      path === "/proc/self/mountinfo" ? host.mountinfo : actual.readFile(path, ...(args as [])),
    access: async (path: string, ...args: unknown[]) =>
      path === "/usr/bin/bwrap" ? undefined : actual.access(path, ...(args as [])),
  };
});
const roots = temporaryRoots();
beforeEach(() =>
  Object.assign(host, {
    absent: false,
    error: "",
    links: 1,
    outsideLink: false,
    owner: 0,
    mode: 0o755,
    mountinfo: "10 1 0:1 / /run rw - tmpfs tmpfs rw\n",
  }),
);

describe("WSL interop command isolation", () => {
  it("retains ordinary Linux when the WSL bridge is absent", async () => {
    host.absent = true;
    expect(await wslInteropMounts()).toEqual([]);
  });
  it("hides standard sockets and their directory and single-socket bind aliases", async () => {
    host.mountinfo += "11 1 0:1 /WSL /alias\\040with\\040spaces rw - tmpfs tmpfs rw\n";
    host.mountinfo += "12 1 0:1 /WSL/2_interop /socket-alias rw - tmpfs tmpfs rw\n";
    host.mountinfo += "13 1 0:1 /wsl/binfmt-status-lock /status-lock ro - tmpfs tmpfs rw\n";
    expect(await wslInteropMounts()).toEqual([
      "--tmpfs",
      "/run/WSL",
      "--tmpfs",
      "/alias with spaces",
      "--ro-bind",
      "/dev/null",
      "/socket-alias",
    ]);
  });
  it.each(["EACCES", "EIO", "ENOTDIR"])(
    "refuses %s rather than treating it as no WSL bridge",
    async (code) => {
      host.error = code;
      await expect(wslInteropMounts()).rejects.toThrow(WSL_INTEROP_FAILURE);
    },
  );
  it.each([
    "malformed",
    "10 1 0:1 / /run rw - tmpfs tmpfs rw\n11 1 0:2 / /run rw - tmpfs tmpfs rw\n",
  ])("refuses malformed or ambiguous mount facts: %s", async (mountinfo) => {
    host.mountinfo = mountinfo;
    await expect(wslInteropMounts()).rejects.toThrow(WSL_INTEROP_FAILURE);
  });
  it("refuses outside symlinks, writable bridges, and non-host-owned bridges", async () => {
    host.outsideLink = true;
    await expect(wslInteropMounts()).rejects.toThrow(WSL_INTEROP_FAILURE);
    host.outsideLink = false;
    host.mode = 0o777;
    await expect(wslInteropMounts()).rejects.toThrow(WSL_INTEROP_FAILURE);
    host.mode = 0o755;
    host.owner = 1000;
    await expect(wslInteropMounts()).rejects.toThrow(WSL_INTEROP_FAILURE);
  });
  it("refuses a multiply-linked socket at the shipped tool before mutation", async () => {
    const root = await roots.create("docsfab-wsl-refusal-");
    await mkdir(join(root, "docs"));
    const guide = join(root, "docs", "guide.md");
    await writeFile(guide, "original\n");
    host.links = 2;
    const mutation = vi.fn(async () => undefined);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const tool = createLiveCommandTool({
        repositoryPath: root,
        allowWrite: true,
        confirm: async () => true,
        beforeMutation: mutation,
      });
      await expect(
        tool.execute(
          "wsl-refusal",
          { command: "printf changed >> docs/guide.md" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(WSL_INTEROP_FAILURE);
      expect(mutation).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
