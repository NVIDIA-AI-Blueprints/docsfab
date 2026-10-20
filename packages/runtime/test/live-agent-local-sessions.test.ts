// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { handleSessionsCommand, parseSessionsArguments } from "../src/cli/commands/sessions.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { repositoryVirtualCwd } from "../src/harness/pi-session.js";
import {
  applyLocalSessionDeletion,
  enforceLocalSessionRetention,
  formatLocalSessionStorageSummary,
  inventoryLocalSessions,
  LocalSessionError,
  localSessionRepositoryLabel,
  planLocalSessionDeletion,
  summarizeLocalSessionStorage,
  sweepExpiredLocalSessions,
} from "../src/live-agent/local-sessions.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  readonly configRoot: string;
  readonly directory: string;
  readonly repoA: string;
  readonly repoB: string;
  readonly outside: string;
  readonly environment: NodeJS.ProcessEnv;
}

async function fixture(): Promise<Fixture> {
  const configRoot = await roots.create("docsfab-sessions-config-", { realpath: true });
  const directory = join(configRoot, ".docsfab", "live-agent", "sessions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const repoA = await roots.create("docsfab-sessions-repo-a-", { realpath: true });
  const repoB = await roots.create("docsfab-sessions-repo-b-", { realpath: true });
  const outside = await roots.create("docsfab-sessions-outside-", { realpath: true });
  return {
    configRoot,
    directory,
    repoA,
    repoB,
    outside,
    environment: { DOCSFAB_CONFIG_ROOT: configRoot },
  };
}

async function writeSession(
  directory: string,
  id: string,
  cwd: string,
  ageDays: number,
): Promise<string> {
  const path = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  await writeFile(
    path,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n${JSON.stringify({ type: "message", text: "private conversation text" })}\n`,
    { mode: 0o600 },
  );
  const at = new Date(NOW - ageDays * DAY - 60 * 60 * 1000);
  await utimes(path, at, at);
  return path;
}

async function writeTaskBranchState(
  directory: string,
  repositoryPath: string,
  ageDays: number,
): Promise<string> {
  await mkdir(join(directory, "task-branches"), { recursive: true, mode: 0o700 });
  const path = join(directory, "task-branches", `${canonicalDigest(repositoryPath)}.json`);
  await writeFile(
    path,
    `${JSON.stringify({ kind: "docsfab-live-agent-task-branch", repositoryPath, branchName: "docs/live-agent/abc" })}\n`,
    { mode: 0o600 },
  );
  const at = new Date(NOW - ageDays * DAY - 60 * 60 * 1000);
  await utimes(path, at, at);
  return path;
}

async function cli(
  f: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = f.environment,
): Promise<string> {
  const lines: string[] = [];
  await handleSessionsCommand(args, { environment, nowMs: NOW, write: (line) => lines.push(line) });
  return lines.join("\n");
}

async function snapshot(directory: string): Promise<string[]> {
  const entries: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    entries.push(name);
    if (name === "task-branches" && (await lstat(join(directory, name))).isDirectory()) {
      for (const child of (await readdir(join(directory, name))).sort()) {
        entries.push(`${name}/${child}`);
      }
    }
  }
  return entries;
}

function confirmationOf(preview: string): string {
  const match = /--confirm (delete-[0-9a-f]+)/u.exec(preview);
  if (!match) throw new Error(`no confirmation in preview:\n${preview}`);
  return match[1]!;
}

describe("local live-agent session inventory", () => {
  it("lists id, age, size, and a repository label that never contains the path", async () => {
    const f = await fixture();
    const current = await writeSession(f.directory, "s-new", repositoryVirtualCwd(f.repoA), 2);
    await writeSession(f.directory, "s-legacy", f.repoA, 40);
    await writeSession(f.directory, "s-other", repositoryVirtualCwd(f.repoB), 10);

    const inventory = await inventoryLocalSessions({ directory: f.directory, nowMs: NOW });

    expect(inventory.sessions.map((session) => [session.id, session.ageDays])).toEqual([
      ["s-new", 2],
      ["s-other", 10],
      ["s-legacy", 40],
    ]);
    const labelA = localSessionRepositoryLabel(f.repoA);
    expect(labelA).toMatch(/^repo-[0-9a-f]{12}$/u);
    expect(inventory.sessions.find((s) => s.id === "s-legacy")?.repository).toBe(labelA);
    expect(inventory.sessions.find((s) => s.id === "s-new")?.repository).toBe(labelA);
    expect(inventory.sessions.find((s) => s.id === "s-new")?.bytes).toBe(
      (await readFile(current)).byteLength,
    );

    const listing = await cli(f, ["list"]);
    expect(listing).toContain("3 local live-agent session(s)");
    expect(listing).toContain("oldest 40 day(s)");
    expect(listing).not.toContain(f.repoA);
    expect(listing).not.toContain(f.repoB);
    expect(listing).toContain("Automatic removal: off (liveAgent.sessionMaxAgeDays = 0)");

    const scoped = await cli(f, ["list", "--repo", f.repoB]);
    expect(scoped).toContain("s-other");
    expect(scoped).not.toContain("s-new");
  });

  it("reports an absent session directory as empty without creating it", async () => {
    const f = await fixture();
    const directory = join(f.configRoot, "never-created");
    const inventory = await inventoryLocalSessions({ directory, nowMs: NOW });
    expect(inventory.present).toBe(false);
    expect(inventory.sessions).toEqual([]);
    expect(existsSync(directory)).toBe(false);
  });
});

describe("docsfab sessions delete", () => {
  it("previews without deleting, then deletes only the targeted session with the preview's token", async () => {
    const f = await fixture();
    const target = await writeSession(f.directory, "s-target", repositoryVirtualCwd(f.repoA), 5);
    const sibling = await writeSession(f.directory, "s-sibling", repositoryVirtualCwd(f.repoA), 1);
    const other = await writeSession(f.directory, "s-other", repositoryVirtualCwd(f.repoB), 50);
    const stateA = await writeTaskBranchState(f.directory, f.repoA, 1);
    const stateB = await writeTaskBranchState(f.directory, f.repoB, 50);
    const before = await snapshot(f.directory);

    const preview = await cli(f, ["delete", "s-target"]);
    expect(preview).toContain(
      "Preview: this would delete 1 session(s) and 0 task-branch state file(s)",
    );
    expect(preview).toContain("Nothing was deleted.");
    expect(await snapshot(f.directory)).toEqual(before);

    const done = await cli(f, ["delete", "s-target", "--confirm", confirmationOf(preview)]);
    expect(done).toContain("Deleted 1 session(s) and 0 task-branch state file(s)");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(other)).toBe(true);
    // repoA still has a session, so its task-branch state stays.
    expect(existsSync(stateA)).toBe(true);
    expect(existsSync(stateB)).toBe(true);

    const last = await cli(f, ["delete", "s-sibling"]);
    expect(last).toContain("1 session(s) and 1 task-branch state file(s)");
    await cli(f, ["delete", "s-sibling", "--confirm", confirmationOf(last)]);
    expect(existsSync(sibling)).toBe(false);
    expect(existsSync(stateA)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(stateB)).toBe(true);
  });

  it("deletes every session and task-branch state with --all", async () => {
    const f = await fixture();
    await writeSession(f.directory, "s-1", repositoryVirtualCwd(f.repoA), 5);
    await writeSession(f.directory, "s-2", repositoryVirtualCwd(f.repoB), 1);
    await writeTaskBranchState(f.directory, f.repoA, 1);
    const preview = await cli(f, ["delete", "--all"]);
    await cli(f, ["delete", "--all", "--confirm", confirmationOf(preview)]);
    expect(await snapshot(f.directory)).toEqual(["task-branches"]);
  });

  it("refuses a confirmation that does not match the current set and deletes nothing", async () => {
    const f = await fixture();
    await writeSession(f.directory, "s-1", repositoryVirtualCwd(f.repoA), 5);
    const preview = await cli(f, ["delete", "--all"]);
    await writeSession(f.directory, "s-late", repositoryVirtualCwd(f.repoA), 0);
    const before = await snapshot(f.directory);
    await expect(
      cli(f, ["delete", "--all", "--confirm", confirmationOf(preview)]),
    ).rejects.toMatchObject({ code: "live-agent-session-confirmation-mismatch" });
    expect(await snapshot(f.directory)).toEqual(before);
  });

  it("binds confirmation to a regular file's identity even when its contents and timestamp match", async () => {
    const f = await fixture();
    const session = await writeSession(f.directory, "s-identity", repositoryVirtualCwd(f.repoA), 1);
    const preview = await cli(f, ["delete", "s-identity"]);
    const original = await lstat(session);
    const replacement = join(f.outside, "replacement.jsonl");
    await writeFile(replacement, await readFile(session));
    await utimes(replacement, original.atime, original.mtime);
    await unlink(session);
    await rename(replacement, session);

    await expect(
      cli(f, ["delete", "s-identity", "--confirm", confirmationOf(preview)]),
    ).rejects.toMatchObject({
      code: "live-agent-session-confirmation-mismatch",
      message: expect.stringContaining("nothing was deleted"),
    });
    expect(existsSync(session)).toBe(true);
  });

  it("refuses a missing or malformed selector before reading anything", () => {
    expect(() => parseSessionsArguments(["delete"])).toThrow(LocalSessionError);
    expect(() => parseSessionsArguments(["delete", "--all", "s-1"])).toThrow(/exactly one of/u);
    expect(() => parseSessionsArguments(["delete", "--older-than", "0"])).toThrow(
      /whole number of days/u,
    );
    expect(() => parseSessionsArguments(["delete", "--older-than", "1e3"])).toThrow(
      /whole number of days/u,
    );
    expect(() => parseSessionsArguments(["list", "--force"])).toThrow(/does not accept/u);
  });
});

describe("session deletion stays inside the session directory", () => {
  it("refuses ids that are paths", async () => {
    const f = await fixture();
    const victim = join(f.outside, "victim.jsonl");
    await writeFile(victim, "keep\n");
    await writeSession(f.directory, "s-1", repositoryVirtualCwd(f.repoA), 1);
    for (const id of ["../victim", `${f.outside}/victim`, "..", "a/b"]) {
      await expect(cli(f, ["delete", id])).rejects.toMatchObject({
        code: "live-agent-session-id-invalid",
      });
    }
    expect(await readFile(victim, "utf8")).toBe("keep\n");
    expect((await snapshot(f.directory)).length).toBe(1);
  });

  it("never follows or deletes a symbolic link, by id or with --all", async () => {
    const f = await fixture();
    const victim = join(f.outside, "victim.jsonl");
    await writeFile(victim, "keep\n");
    await symlink(victim, join(f.directory, "2026-01-01T00-00-00-000Z_s-link.jsonl"));
    const outsideStates = join(f.outside, "states");
    await mkdir(outsideStates);
    const outsideState = join(outsideStates, `${canonicalDigest(f.repoA)}.json`);
    await writeFile(outsideState, "keep\n");
    await symlink(outsideStates, join(f.directory, "task-branches"));
    const real = await writeSession(f.directory, "s-real", repositoryVirtualCwd(f.repoA), 1);

    await expect(cli(f, ["delete", "s-link"])).rejects.toMatchObject({
      code: "live-agent-session-entry-unsafe",
    });
    const listing = await cli(f, ["list"]);
    expect(listing).toContain("Left in place: 2 symbolic link(s)");

    const preview = await cli(f, ["delete", "--all"]);
    expect(preview).toContain("1 session(s) and 0 task-branch state file(s)");
    expect(preview).toContain("task-branches/ is a symbolic link and will remain");
    expect(JSON.parse(await cli(f, ["delete", "--all", "--json"]))).toMatchObject({
      activeSessionMayRecreate: true,
      taskBranchDirectoryLeftInPlace: "symbolic-link",
    });
    const done = await cli(f, ["delete", "--all", "--confirm", confirmationOf(preview)]);
    expect(done).toContain("task-branches/ symbolic link remains");
    expect(existsSync(real)).toBe(false);
    expect(await readFile(victim, "utf8")).toBe("keep\n");
    expect(await readFile(outsideState, "utf8")).toBe("keep\n");
    expect(await snapshot(f.directory)).toEqual([
      "2026-01-01T00-00-00-000Z_s-link.jsonl",
      "task-branches",
    ]);
  });

  it("warns that an open live-agent can recreate a deleted transcript", async () => {
    const f = await fixture();
    await writeSession(f.directory, "s-open", repositoryVirtualCwd(f.repoA), 1);
    const preview = await cli(f, ["delete", "s-open"]);
    expect(preview).toContain("Close any running docsfab live-agent before deletion");
    const done = await cli(f, ["delete", "s-open", "--confirm", confirmationOf(preview)]);
    expect(done).toContain("A still-running docsfab live-agent can recreate");
  });

  it("refuses a session directory that is a symbolic link", async () => {
    const f = await fixture();
    const elsewhere = join(f.outside, "sessions");
    await mkdir(elsewhere);
    const victim = await writeSession(elsewhere, "s-1", repositoryVirtualCwd(f.repoA), 90);
    const linked = join(f.configRoot, "linked-sessions");
    await symlink(elsewhere, linked);
    await expect(inventoryLocalSessions({ directory: linked, nowMs: NOW })).rejects.toMatchObject({
      code: "live-agent-session-directory-unsafe",
    });
    await expect(
      sweepExpiredLocalSessions({ directory: linked, maxAgeDays: 1, nowMs: NOW }),
    ).rejects.toMatchObject({ code: "live-agent-session-directory-unsafe" });
    expect(existsSync(victim)).toBe(true);
  });

  it("refuses a session file replaced by a link after the preview", async () => {
    const f = await fixture();
    const victim = join(f.outside, "victim.jsonl");
    await writeFile(victim, "keep\n");
    const session = await writeSession(f.directory, "s-1", repositoryVirtualCwd(f.repoA), 1);
    const inventory = await inventoryLocalSessions({ directory: f.directory, nowMs: NOW });
    const plan = planLocalSessionDeletion(inventory, { kind: "session", id: "s-1" });
    await writeFile(`${session}.moved`, await readFile(session));
    await unlink(session);
    await symlink(victim, session);
    await expect(applyLocalSessionDeletion(inventory, plan)).rejects.toMatchObject({
      code: "live-agent-session-removal-incomplete",
    });
    expect(await readFile(victim, "utf8")).toBe("keep\n");
  });

  it("refuses a regular-file replacement at apply time and preserves the replacement", async () => {
    const f = await fixture();
    const session = await writeSession(f.directory, "s-regular", repositoryVirtualCwd(f.repoA), 1);
    const inventory = await inventoryLocalSessions({ directory: f.directory, nowMs: NOW });
    const plan = planLocalSessionDeletion(inventory, { kind: "session", id: "s-regular" });
    const original = await lstat(session);
    const content = await readFile(session);
    const held = `${session}.held`;
    await rename(session, held);
    await writeFile(session, content);
    await utimes(session, original.atime, original.mtime);
    const replacement = await lstat(session);
    expect(replacement.ino).not.toBe(original.ino);
    expect(replacement.size).toBe(original.size);
    expect(replacement.mtimeMs).toBe(original.mtimeMs);

    await expect(applyLocalSessionDeletion(inventory, plan)).rejects.toMatchObject({
      code: "live-agent-session-removal-incomplete",
      message: expect.stringContaining("Removed so far: 0 session(s)"),
    });
    expect(await readFile(session)).toEqual(content);
    expect(await readFile(held)).toEqual(content);
  });

  it("refuses an in-place session mtime change with the same inode and byte count", async () => {
    const f = await fixture();
    const session = await writeSession(f.directory, "s-mtime", repositoryVirtualCwd(f.repoA), 1);
    const inventory = await inventoryLocalSessions({ directory: f.directory, nowMs: NOW });
    const plan = planLocalSessionDeletion(inventory, { kind: "session", id: "s-mtime" });
    const original = await lstat(session);
    const content = await readFile(session);
    await utimes(session, original.atime, new Date(original.mtimeMs + 60_000));
    const changed = await lstat(session);
    expect(changed.dev).toBe(original.dev);
    expect(changed.ino).toBe(original.ino);
    expect(changed.size).toBe(original.size);
    expect(changed.mtimeMs).not.toBe(original.mtimeMs);

    await expect(applyLocalSessionDeletion(inventory, plan)).rejects.toMatchObject({
      code: "live-agent-session-removal-incomplete",
      message: expect.stringContaining("Removed so far: 0 session(s)"),
    });
    expect(await readFile(session)).toEqual(content);
  });

  it("refuses a replacement session root before removing any selected file", async () => {
    const f = await fixture();
    await writeSession(f.directory, "s-root", repositoryVirtualCwd(f.repoA), 1);
    const inventory = await inventoryLocalSessions({ directory: f.directory, nowMs: NOW });
    const plan = planLocalSessionDeletion(inventory, { kind: "session", id: "s-root" });
    const originalDirectory = join(f.outside, "original-sessions");
    await rename(f.directory, originalDirectory);
    await mkdir(f.directory);
    const replacement = await writeSession(f.directory, "s-root", repositoryVirtualCwd(f.repoA), 1);

    await expect(applyLocalSessionDeletion(inventory, plan)).rejects.toMatchObject({
      code: "live-agent-session-directory-unsafe",
      message: expect.stringContaining("deleted nothing"),
    });
    expect(existsSync(join(originalDirectory, "2026-01-01T00-00-00-000Z_s-root.jsonl"))).toBe(true);
    expect(existsSync(replacement)).toBe(true);
  });

  it("refuses a replacement task-branch directory before deleting a selected transcript", async () => {
    const f = await fixture();
    const session = await writeSession(f.directory, "s-branch", repositoryVirtualCwd(f.repoA), 1);
    await writeTaskBranchState(f.directory, f.repoA, 1);
    const inventory = await inventoryLocalSessions({ directory: f.directory, nowMs: NOW });
    const plan = planLocalSessionDeletion(inventory, { kind: "session", id: "s-branch" });
    const originalDirectory = join(f.outside, "original-states");
    await rename(join(f.directory, "task-branches"), originalDirectory);
    await mkdir(join(f.directory, "task-branches"));

    await expect(applyLocalSessionDeletion(inventory, plan)).rejects.toMatchObject({
      code: "live-agent-session-directory-unsafe",
      message: expect.stringContaining("deleted nothing"),
    });
    expect(existsSync(session)).toBe(true);
  });

  it("reports a removed transcript when a later task-branch file was replaced", async () => {
    const f = await fixture();
    const session = await writeSession(f.directory, "s-partial", repositoryVirtualCwd(f.repoA), 1);
    const state = await writeTaskBranchState(f.directory, f.repoA, 1);
    const inventory = await inventoryLocalSessions({ directory: f.directory, nowMs: NOW });
    const plan = planLocalSessionDeletion(inventory, { kind: "session", id: "s-partial" });
    const original = await lstat(state);
    await writeFile(state, "replacement state\n");
    await utimes(state, original.atime, original.mtime);
    const changed = await lstat(state);
    expect(changed.dev).toBe(original.dev);
    expect(changed.ino).toBe(original.ino);
    expect(changed.size).not.toBe(original.size);
    expect(changed.mtimeMs).toBe(original.mtimeMs);

    await expect(applyLocalSessionDeletion(inventory, plan)).rejects.toMatchObject({
      code: "live-agent-session-removal-incomplete",
      message: expect.stringContaining(
        "Removed so far: 1 session(s) and 0 task-branch state file(s)",
      ),
    });
    expect(existsSync(session)).toBe(false);
    expect(await readFile(state, "utf8")).toBe("replacement state\n");
  });
});

describe("liveAgent.sessionMaxAgeDays sweep", () => {
  it("removes only sessions last written before the bound", async () => {
    const f = await fixture();
    const old = await writeSession(f.directory, "s-old", repositoryVirtualCwd(f.repoA), 31);
    const edge = await writeSession(f.directory, "s-edge", repositoryVirtualCwd(f.repoA), 29);
    const fresh = await writeSession(f.directory, "s-fresh", repositoryVirtualCwd(f.repoB), 0);
    const oldOnly = await writeSession(
      f.directory,
      "s-old-c",
      "/workspace/".concat("c".repeat(64)),
      45,
    );
    const stateA = await writeTaskBranchState(f.directory, f.repoA, 40);
    const notices: string[] = [];

    const result = await enforceLocalSessionRetention({
      directory: f.directory,
      environment: { ...f.environment, DOCSFAB_LIVE_AGENT_SESSION_MAX_AGE_DAYS: "30" },
      nowMs: NOW,
      notice: (line) => notices.push(line),
    });

    expect(result).toMatchObject({ sessionsRemoved: 2, taskBranchStatesRemoved: 0 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldOnly)).toBe(false);
    expect(existsSync(edge)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    // repoA still has a session inside the bound, so its state stays.
    expect(existsSync(stateA)).toBe(true);
    expect(notices).toEqual([expect.stringContaining("Removed 2 local live-agent session(s)")]);
  });

  it("is off by default and deletes nothing", async () => {
    const f = await fixture();
    const ancient = await writeSession(
      f.directory,
      "s-ancient",
      repositoryVirtualCwd(f.repoA),
      3000,
    );
    const notices: string[] = [];
    const result = await enforceLocalSessionRetention({
      directory: f.directory,
      environment: f.environment,
      nowMs: NOW,
      notice: (line) => notices.push(line),
    });
    expect(result).toBeNull();
    expect(existsSync(ancient)).toBe(true);
    expect(notices).toEqual([]);
  });

  it("refuses an out-of-range bound before deleting anything", async () => {
    const f = await fixture();
    const session = await writeSession(f.directory, "s-1", repositoryVirtualCwd(f.repoA), 90);
    await expect(
      enforceLocalSessionRetention({
        directory: f.directory,
        environment: { ...f.environment, DOCSFAB_LIVE_AGENT_SESSION_MAX_AGE_DAYS: "-1" },
        nowMs: NOW,
        notice: () => undefined,
      }),
    ).rejects.toThrow(/DOCSFAB_LIVE_AGENT_SESSION_MAX_AGE_DAYS/u);
    expect(existsSync(session)).toBe(true);
  });
});

describe("live-agent startup wiring", () => {
  it("applies the retention sweep before it opens or resumes a session", async () => {
    const source = await readFile(new URL("../src/live-agent/host.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export async function runLiveAgent("));
    const sweep = body.indexOf("await enforceLocalSessionRetention({");
    const open = body.indexOf("openLiveAgentSessionManager({");
    expect(sweep).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(sweep);
  });
});

describe("doctor session storage summary", () => {
  it("reports count, total size, oldest age, and the bound", async () => {
    const f = await fixture();
    const a = await writeSession(f.directory, "s-1", repositoryVirtualCwd(f.repoA), 12);
    const b = await writeSession(f.directory, "s-2", repositoryVirtualCwd(f.repoB), 3);
    const summary = await summarizeLocalSessionStorage({
      directory: () => f.directory,
      environment: { ...f.environment, DOCSFAB_LIVE_AGENT_SESSION_MAX_AGE_DAYS: "60" },
      nowMs: NOW,
    });
    const bytes = (await readFile(a)).byteLength + (await readFile(b)).byteLength;
    expect(summary).toEqual({
      state: "present",
      sessions: 2,
      bytes,
      oldestAgeDays: 12,
      taskBranchStates: 0,
      maxAgeDays: 60,
    });
    expect(formatLocalSessionStorageSummary(summary)).toBe(
      `Live-agent sessions: 2 (${bytes.toLocaleString("en-US")} bytes), oldest 12 day(s); automatic removal: after 60 days (liveAgent.sessionMaxAgeDays)`,
    );
  });
});
