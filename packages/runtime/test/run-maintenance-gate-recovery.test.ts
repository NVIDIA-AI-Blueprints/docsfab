// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { limit, limitDefinition } from "../src/config/limits.js";
import { withActiveRunGate, withRunMaintenanceGate } from "../src/records/run-maintenance-gate.js";
import { RUN_GATE_REMOVE_WORKER } from "../src/records/run-gate-remove-source.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots: string[] = [];
const originalHostFile = process.env.DOCSFAB_SERVICE_ENV_FILE;
const acceptanceTimeout = testTimeoutMs(limit("test.offlineDeliveryAcceptanceTimeoutMs").value);

afterEach(async () => {
  if (originalHostFile === undefined) delete process.env.DOCSFAB_SERVICE_ENV_FILE;
  else process.env.DOCSFAB_SERVICE_ENV_FILE = originalHostFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-run-gate-recovery-"));
  roots.push(root);
  return root;
}

async function oneAttempt(root: string): Promise<void> {
  const hostFile = join(root, "limits.env");
  await writeFile(
    hostFile,
    `runs.deletionGateAttempts=` + limitDefinition("runs.deletionGateAttempts").min + "\n",
  );
  process.env.DOCSFAB_SERVICE_ENV_FILE = hostFile;
}

async function crashedActiveOwner(root: string, runId: string): Promise<number> {
  const marker = join(root, "entered");
  const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
  const source =
    `
    import { writeFileSync } from "node:fs";
    import { withActiveRunGate } from ` +
    JSON.stringify(moduleUrl) +
    `;
    await withActiveRunGate(` +
    JSON.stringify(root) +
    `, ` +
    JSON.stringify(runId) +
    `, async () => {
      writeFileSync(` +
    JSON.stringify(marker) +
    `, "entered");
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
  });
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  expect(code).not.toBe(0);
  expect(signal).toBe("SIGKILL");
  expect(await readFile(marker, "utf8")).toBe("entered");
  expect(child.pid).toBeDefined();
  return child.pid!;
}

async function observedRemovalInput(root: string, gateName: string): Promise<string> {
  const gate = join(root, gateName);
  const ownerPath = join(gate, "owner.json");
  const rootStat = await stat(root);
  const gateStat = await stat(gate);
  const ownerStat = await stat(ownerPath);
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid: number; token: string };
  return JSON.stringify({
    operation: "recover",
    name: gateName,
    root: {
      dev: rootStat.dev,
      ino: rootStat.ino,
      uid: rootStat.uid,
      mode: rootStat.mode & 0o7777,
    },
    gate: { dev: gateStat.dev, ino: gateStat.ino },
    owner: { dev: ownerStat.dev, ino: ownerStat.ino },
    ...owner,
  });
}

describe("run maintenance gate owner-death recovery", () => {
  const assertOwnerPublication = async (prefixLength: number) => {
    const root = await realpath(await fixture());
    const ownerPath = join(root, ".docsfab-run-maintenance.lock", "owner.json");
    const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
    const source = `
        import fs from "node:fs/promises";
        import { constants } from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const ownerPath = ${JSON.stringify(ownerPath)};
        const originalOpen = fs.open.bind(fs);
        let publicationStarted;
        let finishPublication;
        let ownerRead;
        let readWhileHeld;
        const started = new Promise((resolve) => { publicationStarted = resolve; });
        const released = new Promise((resolve) => { finishPublication = resolve; });
        const read = new Promise((resolve) => { ownerRead = resolve; });
        const observedHeld = new Promise((resolve) => { readWhileHeld = resolve; });
        let holderInside = false;
        let writerIntercepted = false;
        fs.open = async (...args) => {
          const handle = await originalOpen(...args);
          if (args[0] === ownerPath && (args[1] & constants.O_EXCL) !== 0 && !writerIntercepted) {
            writerIntercepted = true;
            const originalWrite = handle.writeFile.bind(handle);
            handle.writeFile = async (value) => {
              const bytes = String(value);
              await originalWrite(bytes.slice(0, ${prefixLength}));
              publicationStarted();
              await released;
              return originalWrite(bytes.slice(${prefixLength}));
            };
          } else if (args[0] === ownerPath && (args[1] & constants.O_EXCL) === 0) {
            const originalRead = handle.read.bind(handle);
            handle.read = async (...readArgs) => {
              const result = await originalRead(...readArgs);
              ownerRead(result.bytesRead);
              if (holderInside) readWhileHeld();
              return result;
            };
          }
          return handle;
        };
        syncBuiltinESMExports();
        const { withRunMaintenanceGate } = await import(${JSON.stringify(moduleUrl)});
        let active = 0;
        let maximum = 0;
        const action = async (name) => {
          active++;
          maximum = Math.max(maximum, active);
          if (name === "holder") {
            holderInside = true;
            await observedHeld;
            holderInside = false;
          }
          active--;
          return name;
        };
        const holder = withRunMaintenanceGate(${JSON.stringify(root)}, () => action("holder"));
        await started;
        const contender = withRunMaintenanceGate(${JSON.stringify(root)}, () => action("contender"));
        const observedBytes = await read;
        finishPublication();
        const outcomes = await Promise.all([holder, contender]);
        process.stdout.write(JSON.stringify({ observedBytes, outcomes, maximum }));
      `;
    const probe = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: acceptanceTimeout },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      observedBytes: prefixLength,
      outcomes: ["holder", "contender"],
      maximum: 1,
    });
  };

  it(
    "waits for a real owner publication after observing empty bytes",
    () => assertOwnerPublication(0),
    acceptanceTimeout,
  );
  it(
    "waits for a real owner publication after observing partial bytes",
    () => assertOwnerPublication(7),
    acceptanceTimeout,
  );

  it(
    "retries a detached owner descriptor after its real holder releases the gate",
    async () => {
      const root = await realpath(await fixture());
      const gate = join(root, ".docsfab-run-maintenance.lock");
      const ownerPath = join(gate, "owner.json");
      const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
      const source = `
        import fs from "node:fs/promises";
        import { constants } from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const root = ${JSON.stringify(root)};
        const gate = ${JSON.stringify(gate)};
        const ownerPath = ${JSON.stringify(ownerPath)};
        const originalOpen = fs.open.bind(fs);
        let holderInside = false;
        let capturedHandle;
        let notifyOpened;
        let releaseOpen;
        let notifyInside;
        let releaseHolder;
        const opened = new Promise((resolve) => { notifyOpened = resolve; });
        const resumeOpen = new Promise((resolve) => { releaseOpen = resolve; });
        const inside = new Promise((resolve) => { notifyInside = resolve; });
        const resumeHolder = new Promise((resolve) => { releaseHolder = resolve; });
        fs.open = async (...args) => {
          const handle = await originalOpen(...args);
          if (holderInside && !capturedHandle && args[0] === ownerPath &&
              (args[1] & constants.O_EXCL) === 0) {
            capturedHandle = handle;
            notifyOpened();
            await resumeOpen;
          }
          return handle;
        };
        syncBuiltinESMExports();
        const { withRunMaintenanceGate, RunMaintenanceGateError } = await import(${JSON.stringify(moduleUrl)});
        let active = 0;
        let maximum = 0;
        let holderCalls = 0;
        let contenderCalls = 0;
        const action = async (name) => {
          active += 1;
          maximum = Math.max(maximum, active);
          if (name === "holder") {
            holderCalls += 1;
            holderInside = true;
            notifyInside();
            await resumeHolder;
            holderInside = false;
          } else {
            contenderCalls += 1;
          }
          active -= 1;
          return name;
        };
        const result = async (promise) => {
          try { return { state: "ok", value: await promise }; }
          catch (error) {
            return { state: error instanceof RunMaintenanceGateError &&
              (error.code === "unsafe" || error.code === "held") ? error.code : "other" };
          }
        };
        let holder;
        let contender;
        try {
          holder = withRunMaintenanceGate(root, () => action("holder"));
          await inside;
          contender = withRunMaintenanceGate(root, () => action("contender"));
          await Promise.race([opened, contender.then(
            () => { throw new Error("contender-finished-before-open"); },
            () => { throw new Error("contender-failed-before-open"); },
          )]);
          releaseHolder();
          const holderOutcome = await result(holder);
          const detachedNlink = (await capturedHandle.stat()).nlink;
          releaseOpen();
          const contenderOutcome = await result(contender);
          const gateRemaining = await fs.lstat(gate).then(() => true, () => false);
          process.stdout.write(JSON.stringify({
            holderOutcome, contenderOutcome, detachedNlink,
            holderCalls, contenderCalls, maximum, gateRemaining,
          }));
        } finally {
          releaseHolder();
          releaseOpen();
          await Promise.allSettled([holder, contender].filter(Boolean));
        }
      `;
      const probe = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source],
        { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: acceptanceTimeout },
      );
      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(0);
      expect(JSON.parse(probe.stdout), probe.stdout).toEqual({
        holderOutcome: { state: "ok", value: "holder" },
        contenderOutcome: { state: "ok", value: "contender" },
        detachedNlink: 0,
        holderCalls: 1,
        contenderCalls: 1,
        maximum: 1,
        gateRemaining: false,
      });
    },
    acceptanceTimeout,
  );

  // A contender re-reads the owner name after reading its bytes. When the
  // holder's release unlinks that name between the lookup and the attribute
  // read, the kernel reports the doomed inode with nlink 0; under concurrent
  // putRecord calls on a loaded CI host this failed runs as "unsafe" (#2314).
  // The child patches lstat for that one re-check:
  // - "released" opens the name (the lookup), lets the holder's real release
  //   run, then returns the real attributes of the unlinked inode;
  // - "second-link" adds a hard link only for the duration of the re-check;
  // - the "detached" rows report nlink 0 with one other shape check broken.
  // Rows other than "released" allow one acquisition attempt, so a re-check
  // that let the shape through would end "held" instead of "unsafe".
  function contenderAgainstLiveHolder(root: string, variant: string): string {
    const gate = join(root, ".docsfab-run-maintenance.lock");
    const ownerPath = join(gate, "owner.json");
    const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
    return `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const root = ${JSON.stringify(root)};
      const gate = ${JSON.stringify(gate)};
      const ownerPath = ${JSON.stringify(ownerPath)};
      const variant = ${JSON.stringify(variant)};
      const originalLstat = fs.lstat.bind(fs);
      const originalOpen = fs.open.bind(fs);
      let armed = false;
      let intercepted = false;
      let observed;
      let holderSettled;
      let releaseHolder;
      let notifyInside;
      const resumeHolder = new Promise((resolve) => { releaseHolder = resolve; });
      const inside = new Promise((resolve) => { notifyInside = resolve; });
      const shape = (stat) => ({
        nlink: stat.nlink,
        file: stat.isFile(),
        symlink: stat.isSymbolicLink(),
        mode: (stat.mode & 0o7777).toString(8),
      });
      fs.lstat = async (...args) => {
        if (!armed || intercepted || args[0] !== ownerPath) return originalLstat(...args);
        intercepted = true;
        if (variant === "released") {
          const handle = await originalOpen(ownerPath, "r");
          try {
            releaseHolder();
            await holderSettled;
            const doomed = await handle.stat();
            observed = shape(doomed);
            return doomed;
          } finally {
            await handle.close();
          }
        }
        if (variant === "second-link") {
          const second = root + "/owner-second-link";
          await fs.link(ownerPath, second);
          try {
            const linked = await originalLstat(ownerPath);
            observed = shape(linked);
            return linked;
          } finally {
            await fs.unlink(second);
          }
        }
        const real = await originalLstat(ownerPath);
        const changes = { nlink: 0 };
        if (variant === "detached-symlink") changes.mode = (real.mode & 0o7777) | 0o120000;
        if (variant === "detached-mode") changes.mode = (real.mode & ~0o7777) | 0o644;
        if (variant === "detached-uid") changes.uid = real.uid + 1;
        const forged = Object.assign(Object.create(Object.getPrototypeOf(real)), real, changes);
        observed = { ...shape(forged), uidChanged: forged.uid !== real.uid };
        return forged;
      };
      syncBuiltinESMExports();
      const { withRunMaintenanceGate, RunMaintenanceGateError } = await import(${JSON.stringify(moduleUrl)});
      const result = async (promise) => {
        try { return { state: "ok", value: await promise }; }
        catch (error) {
          return { state: error instanceof RunMaintenanceGateError ? error.code : "other" };
        }
      };
      let active = 0;
      let maximum = 0;
      let contenderCalls = 0;
      const holder = withRunMaintenanceGate(root, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        notifyInside();
        await resumeHolder;
        active -= 1;
        return "holder";
      });
      holderSettled = holder.then(() => undefined, () => undefined);
      let contender;
      try {
        await inside;
        armed = true;
        contender = withRunMaintenanceGate(root, async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          contenderCalls += 1;
          active -= 1;
          return "contender";
        });
        const contenderOutcome = await result(contender);
        releaseHolder();
        const holderOutcome = await result(holder);
        process.stdout.write(JSON.stringify({
          holderOutcome, contenderOutcome, intercepted, observed, contenderCalls, maximum,
          gateRemaining: await originalLstat(gate).then(() => true, () => false),
        }));
      } finally {
        releaseHolder();
        await Promise.allSettled([holder, contender].filter(Boolean));
      }
    `;
  }

  function runGateProbe(source: string): unknown {
    const probe = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: acceptanceTimeout },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    return JSON.parse(probe.stdout);
  }

  const refusedWhileHolderLives = {
    holderOutcome: { state: "ok", value: "holder" },
    contenderOutcome: { state: "unsafe" },
    intercepted: true,
    contenderCalls: 0,
    maximum: 1,
    gateRemaining: false,
  } as const;

  it.each([
    [
      "retries an owner name a real release unlinks while the contender reads it",
      "released",
      {
        holderOutcome: { state: "ok", value: "holder" },
        contenderOutcome: { state: "ok", value: "contender" },
        intercepted: true,
        observed: { nlink: 0, file: true, symlink: false, mode: "600" },
        contenderCalls: 1,
        maximum: 1,
        gateRemaining: false,
      },
    ],
    [
      "refuses an owner name with a second link at the name re-check itself",
      "second-link",
      {
        ...refusedWhileHolderLives,
        observed: { nlink: 2, file: true, symlink: false, mode: "600" },
      },
    ],
    [
      "refuses a detached owner name that is a symlink",
      "detached-symlink",
      {
        ...refusedWhileHolderLives,
        observed: { nlink: 0, file: false, symlink: true, mode: "600", uidChanged: false },
      },
    ],
    [
      "refuses a detached owner name with group or other permissions",
      "detached-mode",
      {
        ...refusedWhileHolderLives,
        observed: { nlink: 0, file: true, symlink: false, mode: "644", uidChanged: false },
      },
    ],
    [
      "refuses a detached owner name another user owns",
      "detached-uid",
      {
        ...refusedWhileHolderLives,
        observed: { nlink: 0, file: true, symlink: false, mode: "600", uidChanged: true },
      },
    ],
  ] as const)(
    "%s",
    async (_name, variant, expected) => {
      const root = await realpath(await fixture());
      if (variant !== "released") await oneAttempt(root);
      expect(runGateProbe(contenderAgainstLiveHolder(root, variant))).toEqual(expected);
    },
    acceptanceTimeout,
  );

  // A waiter that finds a dead owner and, during its name re-check, sees
  // another waiter's real reaper unlink that owner must neither recover
  // through the detached observation nor give up: it observes again and takes
  // the free gate.
  it(
    "takes the gate, without recovering through it, after another reaper unlinks a dead owner mid re-check",
    async () => {
      const root = await realpath(await fixture());
      const gateName = ".docsfab-run-maintenance.lock";
      const gate = join(root, gateName);
      const ownerPath = join(gate, "owner.json");
      const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(dead, "close");
      await mkdir(gate, { mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({ pid: dead.pid, token: randomUUID() }), {
        mode: 0o600,
      });
      const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
      const workerUrl = pathToFileURL(resolve("src/records/run-gate-remove-source.ts")).href;
      const source = `
        import fs from "node:fs/promises";
        import { statSync } from "node:fs";
        import { spawnSync } from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const root = ${JSON.stringify(root)};
        const gate = ${JSON.stringify(gate)};
        const ownerPath = ${JSON.stringify(ownerPath)};
        const { RUN_GATE_REMOVE_WORKER } = await import(${JSON.stringify(workerUrl)});
        const originalLstat = fs.lstat.bind(fs);
        const originalOpen = fs.open.bind(fs);
        let intercepted = false;
        let observedNlink;
        let reaperStatus;
        fs.lstat = async (...args) => {
          if (intercepted || args[0] !== ownerPath) return originalLstat(...args);
          intercepted = true;
          const handle = await originalOpen(ownerPath, "r");
          try {
            const rootStat = statSync(root);
            const gateStat = statSync(gate);
            const ownerStat = await handle.stat();
            const owner = JSON.parse(await handle.readFile("utf8"));
            const input = JSON.stringify({
              operation: "recover",
              name: ${JSON.stringify(gateName)},
              root: { dev: rootStat.dev, ino: rootStat.ino, uid: rootStat.uid, mode: rootStat.mode & 0o7777 },
              gate: { dev: gateStat.dev, ino: gateStat.ino },
              owner: { dev: ownerStat.dev, ino: ownerStat.ino },
              pid: owner.pid,
              token: owner.token,
            });
            const reaper = spawnSync(process.execPath, ["--input-type=module", "-e", RUN_GATE_REMOVE_WORKER], {
              cwd: root,
              env: { DOCSFAB_RUN_GATE_REMOVE: input, LC_ALL: "C", LANG: "C" },
              stdio: "ignore",
            });
            reaperStatus = reaper.status;
            const doomed = await handle.stat();
            observedNlink = doomed.nlink;
            return doomed;
          } finally {
            await handle.close();
          }
        };
        syncBuiltinESMExports();
        const { withRunMaintenanceGate, RunMaintenanceGateError } = await import(${JSON.stringify(moduleUrl)});
        let actions = 0;
        let outcome;
        try {
          await withRunMaintenanceGate(root, async () => { actions += 1; });
          outcome = "acquired";
        } catch (error) {
          outcome = error instanceof RunMaintenanceGateError ? error.code : "other";
        }
        process.stdout.write(JSON.stringify({
          intercepted, reaperStatus, observedNlink, outcome, actions,
          gateRemaining: await originalLstat(gate).then(() => true, () => false),
        }));
      `;
      expect(runGateProbe(source)).toEqual({
        intercepted: true,
        reaperStatus: 0,
        observedNlink: 0,
        outcome: "acquired",
        actions: 1,
        gateRemaining: false,
      });
    },
    acceptanceTimeout,
  );

  // The same detached owner never authorizes an action: a holder whose fresh
  // owner is unlinked during its own post-acquisition self-check refuses.
  it(
    "refuses before acting when its own fresh owner is unlinked during the self-check",
    async () => {
      const root = await realpath(await fixture());
      const gate = join(root, ".docsfab-run-maintenance.lock");
      const ownerPath = join(gate, "owner.json");
      const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
      const source = `
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        const ownerPath = ${JSON.stringify(ownerPath)};
        const root = ${JSON.stringify(root)};
        const originalLstat = fs.lstat.bind(fs);
        const originalOpen = fs.open.bind(fs);
        let intercepted = false;
        let observedNlink;
        fs.lstat = async (...args) => {
          if (intercepted || args[0] !== ownerPath) return originalLstat(...args);
          intercepted = true;
          const handle = await originalOpen(ownerPath, "r");
          try {
            await fs.unlink(ownerPath);
            const doomed = await handle.stat();
            observedNlink = doomed.nlink;
            return doomed;
          } finally {
            await handle.close();
          }
        };
        syncBuiltinESMExports();
        const { withRunMaintenanceGate, RunMaintenanceGateError } = await import(${JSON.stringify(moduleUrl)});
        let actions = 0;
        let outcome;
        try {
          await withRunMaintenanceGate(root, async () => { actions += 1; });
          outcome = "acquired";
        } catch (error) {
          outcome = error instanceof RunMaintenanceGateError ? error.code : "other";
        }
        process.stdout.write(JSON.stringify({ intercepted, observedNlink, outcome, actions }));
      `;
      expect(runGateProbe(source)).toEqual({
        intercepted: true,
        observedNlink: 0,
        outcome: "unsafe",
        actions: 0,
      });
    },
    acceptanceTimeout,
  );

  it(
    "does not recover a detached dead owner when its directory remains ownerless",
    async () => {
      const root = await realpath(await fixture());
      const gate = join(root, ".docsfab-run-maintenance.lock");
      const ownerPath = join(gate, "owner.json");
      const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(dead, "close");
      await mkdir(gate, { mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({ pid: dead.pid, token: randomUUID() }), {
        mode: 0o600,
      });
      const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
      const source = `
        import fs from "node:fs/promises";
        import { constants } from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const root = ${JSON.stringify(root)};
        const gate = ${JSON.stringify(gate)};
        const ownerPath = ${JSON.stringify(ownerPath)};
        const originalOpen = fs.open.bind(fs);
        let capturedHandle;
        let notifyOpened;
        let releaseOpen;
        const opened = new Promise((resolve) => { notifyOpened = resolve; });
        const resumeOpen = new Promise((resolve) => { releaseOpen = resolve; });
        fs.open = async (...args) => {
          const handle = await originalOpen(...args);
          if (!capturedHandle && args[0] === ownerPath &&
              (args[1] & constants.O_EXCL) === 0) {
            capturedHandle = handle;
            notifyOpened();
            await resumeOpen;
          }
          return handle;
        };
        syncBuiltinESMExports();
        const { withRunMaintenanceGate, RunMaintenanceGateError } = await import(${JSON.stringify(moduleUrl)});
        let actions = 0;
        let attempt;
        try {
          attempt = withRunMaintenanceGate(root, async () => { actions += 1; });
          await Promise.race([opened, attempt.then(
            () => { throw new Error("attempt-finished-before-open"); },
            () => { throw new Error("attempt-failed-before-open"); },
          )]);
          await fs.unlink(ownerPath);
          const detachedNlink = (await capturedHandle.stat()).nlink;
          releaseOpen();
          let outcome = "returned";
          try { await attempt; }
          catch (error) {
            outcome = error instanceof RunMaintenanceGateError && error.code === "held"
              ? "held" : "other";
          }
          process.stdout.write(JSON.stringify({
            detachedNlink, outcome, actions,
            gateRemaining: await fs.lstat(gate).then(() => true, () => false),
            ownerRemaining: await fs.lstat(ownerPath).then(() => true, () => false),
          }));
        } finally {
          releaseOpen();
          await Promise.allSettled([attempt].filter(Boolean));
        }
      `;
      const probe = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source],
        { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: acceptanceTimeout },
      );
      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(0);
      expect(JSON.parse(probe.stdout), probe.stdout).toEqual({
        detachedNlink: 0,
        outcome: "held",
        actions: 0,
        gateRemaining: true,
        ownerRemaining: false,
      });
    },
    acceptanceTimeout,
  );

  it(
    "stages and reads all three quality artifacts while an owner is publishing",
    async () => {
      const root = await realpath(await fixture());
      const artifactRoot = join(root, "artifacts");
      const ownerPath = join(artifactRoot, ".docsfab-run-maintenance.lock", "owner.json");
      const storeUrl = pathToFileURL(resolve("src/artifacts/store.ts")).href;
      const stagingUrl = pathToFileURL(
        resolve("src/evaluation-report/quality-artifact-staging.ts"),
      ).href;
      const source = `
      import fs from "node:fs/promises";
      import { constants } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { isDeepStrictEqual } from "node:util";
      const ownerPath = ${JSON.stringify(ownerPath)};
      const originalOpen = fs.open.bind(fs);
      let publicationStarted;
      let finishPublication;
      let ownerRead;
      const started = new Promise((resolve) => { publicationStarted = resolve; });
      const released = new Promise((resolve) => { finishPublication = resolve; });
      const read = new Promise((resolve) => { ownerRead = resolve; });
      let writerIntercepted = false;
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === ownerPath && (args[1] & constants.O_EXCL) !== 0 && !writerIntercepted) {
          writerIntercepted = true;
          const originalWrite = handle.writeFile.bind(handle);
          handle.writeFile = async (value) => {
            publicationStarted();
            await released;
            return originalWrite(value);
          };
        } else if (args[0] === ownerPath && (args[1] & constants.O_EXCL) === 0) {
          const originalRead = handle.read.bind(handle);
          handle.read = async (...readArgs) => {
            const result = await originalRead(...readArgs);
            ownerRead(result.bytesRead);
            return result;
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      const { DurableArtifactStore } = await import(${JSON.stringify(storeUrl)});
      const { stageQualityArtifactCandidate, loadStagedQualityArtifact } = await import(${JSON.stringify(stagingUrl)});
      const revision = "b".repeat(40);
      const selectionSha256 = "a".repeat(64);
      const qualityPackBindingSha256 = "c".repeat(64);
      const selection = {
        receipt: {
          selectionSha256,
          profileId: "fixture-profile",
          profileVersion: "v1",
          profileModel: "fixture-model",
          repositoryRevision: revision,
          qualityPackBindingSha256,
        },
        evaluationTarget: [{ path: "docs/guide.md" }],
      };
      const candidate = {
        evaluation: {
          profile: { id: "fixture-profile", version: "v1" },
          model_version: "fixture-model",
          target: {
            scope_type: "documentation-set",
            repository_revision: revision,
            paths: ["docs/guide.md"],
          },
        },
        qualityScore: { score: 1 },
        reportMarkdown: "# Fixture report",
        selectionSha256,
      };
      const store = new DurableArtifactStore(${JSON.stringify(artifactRoot)});
      const stagedPromise = stageQualityArtifactCandidate({
        store, candidate, selection,
        bindings: {
          runId: "quality-publication",
          repositoryRevision: revision,
          selectionSha256,
          evaluatorIdentitySha256: "d".repeat(64),
          qualityPackBindingSha256,
        },
      });
      await started;
      const observedBytes = await read;
      finishPublication();
      const staged = await stagedPromise;
      const entries = [staged.evaluation, staged.qualityScore, staged.candidateReport];
      const loaded = await Promise.all(entries.map(async (entry) => {
        const record = await loadStagedQualityArtifact(store, entry.binding.recordSha256);
        return {
          digest: entry.binding.recordSha256,
          sameRecord: isDeepStrictEqual(record, entry.record),
          kind: record.artifactKind,
        };
      }));
      process.stdout.write(JSON.stringify({ observedBytes, loaded }));
    `;
      const probe = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source],
        { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: acceptanceTimeout },
      );
      expect(probe.error).toBeUndefined();
      expect(probe.status, probe.stderr).toBe(0);
      const result = JSON.parse(probe.stdout) as {
        observedBytes: number;
        loaded: Array<{ digest: string; sameRecord: boolean; kind: string }>;
      };
      expect(result.observedBytes).toBe(0);
      expect(result.loaded.map((entry) => entry.kind)).toEqual([
        "evaluation",
        "quality-score",
        "candidate-report",
      ]);
      expect(
        result.loaded.every((entry) => /^[a-f0-9]{64}$/u.test(entry.digest) && entry.sameRecord),
      ).toBe(true);
    },
    acceptanceTimeout,
  );

  it(
    "stages and reloads three concurrent quality artifacts after a real holder detaches its owner",
    async () => {
      const root = await realpath(await fixture());
      const artifactRoot = join(root, "artifacts");
      await mkdir(artifactRoot, { mode: 0o700 });
      const ownerPath = join(artifactRoot, ".docsfab-run-maintenance.lock", "owner.json");
      const gateUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
      const storeUrl = pathToFileURL(resolve("src/artifacts/store.ts")).href;
      const stagingUrl = pathToFileURL(
        resolve("src/evaluation-report/quality-artifact-staging.ts"),
      ).href;
      const source = `
        import fs from "node:fs/promises";
        import { constants } from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        import { isDeepStrictEqual } from "node:util";
        const artifactRoot = ${JSON.stringify(artifactRoot)};
        const ownerPath = ${JSON.stringify(ownerPath)};
        const originalOpen = fs.open.bind(fs);
        let holderInside = false;
        let capturedHandle;
        let notifyOpened;
        let releaseOpen;
        let notifyInside;
        let releaseHolder;
        const opened = new Promise((resolve) => { notifyOpened = resolve; });
        const resumeOpen = new Promise((resolve) => { releaseOpen = resolve; });
        const inside = new Promise((resolve) => { notifyInside = resolve; });
        const resumeHolder = new Promise((resolve) => { releaseHolder = resolve; });
        fs.open = async (...args) => {
          const handle = await originalOpen(...args);
          if (holderInside && !capturedHandle && args[0] === ownerPath &&
              (args[1] & constants.O_EXCL) === 0) {
            capturedHandle = handle;
            notifyOpened();
            await resumeOpen;
          }
          return handle;
        };
        syncBuiltinESMExports();
        const { withRunMaintenanceGate } = await import(${JSON.stringify(gateUrl)});
        const { DurableArtifactStore } = await import(${JSON.stringify(storeUrl)});
        const { stageQualityArtifactCandidate, loadStagedQualityArtifact } = await import(${JSON.stringify(stagingUrl)});
        const revision = "b".repeat(40);
        const selectionSha256 = "a".repeat(64);
        const qualityPackBindingSha256 = "c".repeat(64);
        const selection = {
          receipt: {
            selectionSha256,
            profileId: "fixture-profile",
            profileVersion: "v1",
            profileModel: "fixture-model",
            repositoryRevision: revision,
            qualityPackBindingSha256,
          },
          evaluationTarget: [{ path: "docs/guide.md" }],
        };
        const candidate = {
          evaluation: {
            profile: { id: "fixture-profile", version: "v1" },
            model_version: "fixture-model",
            target: {
              scope_type: "documentation-set",
              repository_revision: revision,
              paths: ["docs/guide.md"],
            },
          },
          qualityScore: { score: 1 },
          reportMarkdown: "# Fixture report",
          selectionSha256,
        };
        const store = new DurableArtifactStore(artifactRoot);
        let holder;
        let staging;
        try {
          holder = withRunMaintenanceGate(artifactRoot, async () => {
            holderInside = true;
            notifyInside();
            await resumeHolder;
            holderInside = false;
          });
          await inside;
          staging = stageQualityArtifactCandidate({
            store, candidate, selection,
            bindings: {
              runId: "quality-release-handoff",
              repositoryRevision: revision,
              selectionSha256,
              evaluatorIdentitySha256: "d".repeat(64),
              qualityPackBindingSha256,
            },
          });
          await Promise.race([opened, staging.then(
            () => { throw new Error("staging-finished-before-open"); },
            () => { throw new Error("staging-failed-before-open"); },
          )]);
          releaseHolder();
          await holder;
          const detachedNlink = (await capturedHandle.stat()).nlink;
          releaseOpen();
          const staged = await staging;
          const entries = [staged.evaluation, staged.qualityScore, staged.candidateReport];
          const loaded = await Promise.all(entries.map(async (entry) => {
            const record = await loadStagedQualityArtifact(store, entry.binding.recordSha256);
            return {
              kind: record.artifactKind,
              sameRecord: isDeepStrictEqual(record, entry.record),
              digestValid: /^[a-f0-9]{64}$/.test(entry.binding.recordSha256),
            };
          }));
          process.stdout.write(JSON.stringify({ detachedNlink, loaded }));
        } finally {
          releaseHolder();
          releaseOpen();
          await Promise.allSettled([holder, staging].filter(Boolean));
        }
      `;
      const probe = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source],
        { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: acceptanceTimeout },
      );
      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(0);
      expect(JSON.parse(probe.stdout), probe.stdout).toEqual({
        detachedNlink: 0,
        loaded: [
          { kind: "evaluation", sameRecord: true, digestValid: true },
          { kind: "quality-score", sameRecord: true, digestValid: true },
          { kind: "candidate-report", sameRecord: true, digestValid: true },
        ],
      });
    },
    acceptanceTimeout,
  );

  it("refuses a dead gate through the public index reader when root ownership differs from the operator", async () => {
    const root = await fixture();
    const gate = join(root, ".docsfab-run-maintenance.lock");
    const ownerPath = join(gate, "owner.json");
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(dead, "close");
    const bytes = JSON.stringify({ pid: dead.pid, token: randomUUID() });
    await mkdir(gate, { mode: 0o700 });
    await writeFile(ownerPath, bytes, { mode: 0o600 });
    const indexUrl = pathToFileURL(resolve("src/records/run-index-store.ts")).href;
    const limitsUrl = pathToFileURL(resolve("src/config/limits.ts")).href;
    const source = `
      const actualUid = process.getuid();
      process.getuid = () => actualUid + 1;
      const { readRunIndex } = await import(${JSON.stringify(indexUrl)});
      const { limit } = await import(${JSON.stringify(limitsUrl)});
      try {
        await readRunIndex({
          indexDirectory: ${JSON.stringify(root)},
          maxBytes: limit("runs.indexMaxBytes"),
          onOversize: () => { throw new Error("oversize"); },
        });
        process.stdout.write("returned");
      } catch (error) {
        process.stdout.write(error?.code ?? "unknown");
      }
    `;
    const probe = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
        timeout: acceptanceTimeout,
      },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toBe("unsafe");
    expect(await readFile(ownerPath, "utf8")).toBe(bytes);
    expect((await stat(gate)).isDirectory()).toBe(true);
  });

  it("refuses direct recovery helper cleanup when root ownership differs from the helper operator", async () => {
    const root = await fixture();
    const gateName = ".docsfab-run-maintenance.lock";
    const gate = join(root, gateName);
    const ownerPath = join(gate, "owner.json");
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(dead, "close");
    const bytes = JSON.stringify({ pid: dead.pid, token: randomUUID() });
    await mkdir(gate, { mode: 0o700 });
    await writeFile(ownerPath, bytes, { mode: 0o600 });
    const input = await observedRemovalInput(root, gateName);
    const shim = join(root, "different-operator.mjs");
    await writeFile(
      shim,
      "const actualUid = process.getuid(); process.getuid = () => actualUid + 1;\n",
      { mode: 0o600 },
    );
    const probe = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(shim).href, "--input-type=module", "-e", RUN_GATE_REMOVE_WORKER],
      {
        cwd: root,
        env: { DOCSFAB_RUN_GATE_REMOVE: input, LC_ALL: "C", LANG: "C" },
        stdio: "ignore",
        timeout: limit("runs.deletionGateHelperTimeoutMs").value,
      },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(2);
    expect(await readFile(ownerPath, "utf8")).toBe(bytes);
    expect((await stat(gate)).isDirectory()).toBe(true);
  });

  it(
    "resumes the exact active run after SIGKILL and serializes two recovery contenders",
    async () => {
      const root = await fixture();
      const runId = "crash-resume";
      await oneAttempt(root);
      await crashedActiveOwner(root, runId);
      await withActiveRunGate(root, runId, async () => undefined);
      await crashedActiveOwner(root, runId);
      let active = 0;
      let maximum = 0;
      const action = () =>
        withActiveRunGate(root, runId, async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await pause(limit("runs.deletionGateRetryPauseMs").value);
          active -= 1;
        });
      // One contender may legitimately observe the other's complete live
      // owner and exhaust a one-attempt override. Give both the normal bounded
      // retry budget for this concurrency assertion.
      delete process.env.DOCSFAB_SERVICE_ENV_FILE;
      const outcomes = await Promise.allSettled([action(), action()]);
      expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          expect(outcome.reason).toMatchObject({ code: expect.stringMatching(/^(held|unsafe)$/u) });
        }
      }
      expect(maximum).toBe(1);
      expect(active).toBe(0);
      await withActiveRunGate(root, runId, async () => undefined);
    },
    acceptanceTimeout,
  );

  it("refuses a live owner and leaves unknown or partial initializers intact", async () => {
    const root = await fixture();
    await oneAttempt(root);
    const gate = join(root, ".docsfab-run-maintenance.lock");
    await mkdir(gate, { mode: 0o700 });
    await expect(withRunMaintenanceGate(root, async () => undefined)).rejects.toMatchObject({
      code: "held",
    });
    expect(await stat(gate)).toMatchObject({ mode: expect.any(Number) });
    // More than one observation still refuses an owner that never finishes
    // publishing; no cleanup or action is authorized.
    await writeFile(
      join(root, "limits.env"),
      `runs.deletionGateAttempts=${limitDefinition("runs.deletionGateAttempts").min + 1}\n`,
    );
    await writeFile(join(gate, "owner.json"), "{", { mode: 0o600 });
    await expect(withRunMaintenanceGate(root, async () => undefined)).rejects.toMatchObject({
      code: "unsafe",
    });
    expect(await readFile(join(gate, "owner.json"), "utf8")).toBe("{");
    await rm(join(gate, "owner.json"));
    const fifo = spawnSync("mkfifo", [join(gate, "owner.json")], { encoding: "utf8" });
    expect(fifo.status).toBe(0);
    const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
    const source = `
      import { withRunMaintenanceGate } from ${JSON.stringify(moduleUrl)};
      try {
        await withRunMaintenanceGate(${JSON.stringify(root)}, async () => undefined);
        process.stdout.write("acquired");
      } catch (error) {
        process.stdout.write(error?.code ?? "unknown");
      }
    `;
    const probe = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
        timeout: limit("runs.deletionGateHelperTimeoutMs").value,
      },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe("unsafe");
    expect((await stat(join(gate, "owner.json"))).isFIFO()).toBe(true);
    await rm(gate, { recursive: true });

    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withRunMaintenanceGate(root, async () => {
      entered();
      await held;
    });
    await inside;
    try {
      await expect(withRunMaintenanceGate(root, async () => undefined)).rejects.toMatchObject({
        code: "held",
      });
      expect(await readFile(join(gate, "owner.json"), "utf8")).toContain('"pid":');
    } finally {
      release();
      await holder;
    }
  });

  it("refuses unsafe private entries, owner encodings, and uncertain liveness", async () => {
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(dead, "close");
    const pid = dead.pid!;
    for (const variant of [
      "gate-mode",
      "gate-symlink",
      "owner-mode",
      "owner-symlink",
      "owner-hardlink",
      "owner-schema",
      "owner-token",
      "owner-pid",
      "owner-oversize",
      "extra-entry",
    ] as const) {
      const root = await fixture();
      await oneAttempt(root);
      const gate = join(root, ".docsfab-run-maintenance.lock");
      const ownerPath = join(gate, "owner.json");
      const bytes = JSON.stringify({ pid, token: randomUUID() });
      await mkdir(gate, { mode: 0o700 });
      await writeFile(ownerPath, bytes, { mode: 0o600 });
      if (variant === "gate-mode") await chmod(gate, 0o755);
      if (variant === "gate-symlink") {
        const target = join(root, "gate-target");
        await mkdir(target, { mode: 0o700 });
        await rm(gate, { recursive: true });
        await symlink(target, gate);
      }
      if (variant === "owner-mode") await chmod(ownerPath, 0o644);
      if (variant === "owner-symlink") {
        const target = join(root, "owner-target");
        await writeFile(target, bytes, { mode: 0o600 });
        await rm(ownerPath);
        await symlink(target, ownerPath);
      }
      if (variant === "owner-hardlink") await link(ownerPath, join(root, "owner-link"));
      if (variant === "owner-schema") {
        await writeFile(ownerPath, JSON.stringify({ pid, token: randomUUID(), other: true }));
      }
      if (variant === "owner-token") {
        await writeFile(ownerPath, JSON.stringify({ pid, token: "not-a-token" }));
      }
      if (variant === "owner-pid") {
        await writeFile(ownerPath, JSON.stringify({ pid: 0, token: randomUUID() }));
      }
      if (variant === "owner-oversize") {
        const largestOwner = JSON.stringify({
          pid: Number.MAX_SAFE_INTEGER,
          token: "00000000-0000-4000-8000-000000000000",
        });
        await writeFile(ownerPath, "x".repeat(Buffer.byteLength(largestOwner) + 1));
      }
      if (variant === "extra-entry") await writeFile(join(gate, "unexpected"), "preserve");
      let entered = false;
      await expect(
        withRunMaintenanceGate(root, async () => {
          entered = true;
        }),
        variant,
      ).rejects.toMatchObject({ code: "unsafe" });
      expect(entered, variant).toBe(false);
      expect(await lstat(gate), variant).toBeDefined();
      if (variant !== "gate-symlink") expect(await lstat(ownerPath), variant).toBeDefined();
    }

    const root = await fixture();
    await oneAttempt(root);
    const gate = join(root, ".docsfab-run-maintenance.lock");
    await mkdir(gate, { mode: 0o700 });
    await writeFile(join(gate, "owner.json"), JSON.stringify({ pid, token: randomUUID() }), {
      mode: 0o600,
    });
    const originalKill = process.kill;
    const kill = vi.spyOn(process, "kill").mockImplementation(((target, signal) => {
      if (target === pid && signal === 0) {
        throw Object.assign(new Error("unknown process liveness"), { code: "EPERM" });
      }
      return originalKill(target, signal);
    }) as typeof process.kill);
    try {
      await expect(withRunMaintenanceGate(root, async () => undefined)).rejects.toMatchObject({
        code: "held",
      });
      expect(await lstat(join(gate, "owner.json"))).toBeDefined();
    } finally {
      kill.mockRestore();
    }
  });

  it(
    "refuses a fully parsed invalid owner on its first observation",
    async () => {
      const root = await realpath(await fixture());
      const gate = join(root, ".docsfab-run-maintenance.lock");
      const ownerPath = join(gate, "owner.json");
      await mkdir(gate, { mode: 0o700 });
      const bytes = JSON.stringify({ pid: process.pid, token: randomUUID(), extra: true });
      await writeFile(ownerPath, bytes, { mode: 0o600 });
      const hostFile = join(root, "limits.env");
      await writeFile(
        hostFile,
        `runs.deletionGateAttempts=${limitDefinition("runs.deletionGateAttempts").min + 1}\n`,
      );
      const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
      const source = `
      import fs from "node:fs/promises";
      import { constants } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const ownerPath = ${JSON.stringify(ownerPath)};
      const originalOpen = fs.open.bind(fs);
      let observations = 0;
      fs.open = async (...args) => {
        if (args[0] === ownerPath && (args[1] & constants.O_EXCL) === 0) observations++;
        return originalOpen(...args);
      };
      syncBuiltinESMExports();
      const { withRunMaintenanceGate } = await import(${JSON.stringify(moduleUrl)});
      let code = "acquired";
      try {
        await withRunMaintenanceGate(${JSON.stringify(root)}, async () => undefined);
      } catch (error) {
        code = error?.code ?? "unknown";
      }
      process.stdout.write(JSON.stringify({ code, observations }));
    `;
      const probe = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source],
        {
          cwd: process.cwd(),
          env: { ...process.env, DOCSFAB_SERVICE_ENV_FILE: hostFile },
          encoding: "utf8",
          timeout: acceptanceTimeout,
        },
      );
      expect(probe.error).toBeUndefined();
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout)).toEqual({ code: "unsafe", observations: 1 });
      expect(await readFile(ownerPath, "utf8")).toBe(bytes);
    },
    acceptanceTimeout,
  );

  it(
    "keeps a complete successor when a delayed old-directory reaper loses its name",
    async () => {
      const root = await fixture();
      const gateName = ".docsfab-run-maintenance.lock";
      const gate = join(root, gateName);
      await mkdir(gate, { mode: 0o700 });
      const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(dead, "close");
      const oldOwner = { pid: dead.pid!, token: randomUUID() };
      const oldBytes = JSON.stringify(oldOwner);
      const ownerPath = join(gate, "owner.json");
      await writeFile(ownerPath, oldBytes, { mode: 0o600 });
      const marker = join(root, "old-owner-unlinked");
      const resume = join(root, "resume-reaper");
      const shim = join(root, "pause-after-unlink.mjs");
      await writeFile(
        shim,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.unlinkSync;
fs.unlinkSync = function(path) {
  original.call(fs, path);
  if (path === "owner.json") {
    fs.writeFileSync(` +
          JSON.stringify(marker) +
          `, "paused");
    while (!fs.existsSync(` +
          JSON.stringify(resume) +
          `)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
};
syncBuiltinESMExports();
`,
        { mode: 0o600 },
      );
      const input = await observedRemovalInput(root, gateName);
      const reaper = spawn(
        process.execPath,
        ["--import", pathToFileURL(shim).href, "--input-type=module", "-e", RUN_GATE_REMOVE_WORKER],
        {
          cwd: root,
          env: { DOCSFAB_RUN_GATE_REMOVE: input, LC_ALL: "C", LANG: "C" },
          stdio: "ignore",
        },
      );
      const closed = once(reaper, "close");
      try {
        const deadline = Date.now() + limit("test.offlineDeliveryAcceptanceTimeoutMs").value;
        while (!existsSync(marker) && Date.now() < deadline) await pause(10);
        expect(existsSync(marker)).toBe(true);
        await oneAttempt(root);
        await expect(withRunMaintenanceGate(root, async () => undefined)).rejects.toMatchObject({
          code: "held",
        });
        expect((await stat(gate)).isDirectory()).toBe(true);
        await rmdir(gate);
        await mkdir(gate, { mode: 0o700 });
        const successorBytes = JSON.stringify({ pid: process.pid, token: randomUUID() });
        await writeFile(ownerPath, successorBytes, { mode: 0o600 });
        await writeFile(resume, "resume");
        const [code] = (await closed) as [number | null, NodeJS.Signals | null];
        expect(code).toBe(3);
        expect(await readFile(ownerPath, "utf8")).toBe(successorBytes);
      } finally {
        await writeFile(resume, "resume").catch(() => undefined);
        reaper.kill("SIGKILL");
        await closed;
      }
    },
    acceptanceTimeout,
  );

  it(
    "lets a real contender replace a dead gate while an older reaper pauses before owner unlink",
    async () => {
      const root = await fixture();
      const gateName = ".docsfab-run-maintenance.lock";
      const gate = join(root, gateName);
      await mkdir(gate, { mode: 0o700 });
      const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(dead, "close");
      await writeFile(
        join(gate, "owner.json"),
        JSON.stringify({ pid: dead.pid, token: randomUUID() }),
        {
          mode: 0o600,
        },
      );
      const input = await observedRemovalInput(root, gateName);
      const marker = join(root, "before-owner-unlink");
      const resume = join(root, "resume-old-reaper");
      const shim = join(root, "pause-before-unlink.mjs");
      await writeFile(
        shim,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.unlinkSync;
fs.unlinkSync = function(path) {
  if (path === "owner.json") {
    fs.writeFileSync(${JSON.stringify(marker)}, "paused");
    while (!fs.existsSync(${JSON.stringify(resume)})) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return original.call(fs, path);
};
syncBuiltinESMExports();
`,
        { mode: 0o600 },
      );
      const reaper = spawn(
        process.execPath,
        ["--import", pathToFileURL(shim).href, "--input-type=module", "-e", RUN_GATE_REMOVE_WORKER],
        {
          cwd: root,
          env: { DOCSFAB_RUN_GATE_REMOVE: input, LC_ALL: "C", LANG: "C" },
          stdio: "ignore",
        },
      );
      const closed = once(reaper, "close");
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let contender: Promise<void> | undefined;
      try {
        const deadline = Date.now() + limit("test.offlineDeliveryAcceptanceTimeoutMs").value;
        while (!existsSync(marker) && Date.now() < deadline) await pause(10);
        expect(existsSync(marker)).toBe(true);
        await oneAttempt(root);
        contender = withRunMaintenanceGate(root, async () => {
          entered();
          await held;
        });
        await Promise.race([
          inside,
          contender.then(
            () => Promise.reject(new Error("contender exited before acquiring the gate")),
            (error: unknown) => Promise.reject(error),
          ),
        ]);
        const successorBytes = await readFile(join(gate, "owner.json"), "utf8");
        expect(JSON.parse(successorBytes)).toMatchObject({ pid: process.pid });
        await writeFile(resume, "resume");
        const [code] = (await closed) as [number | null, NodeJS.Signals | null];
        expect(code).toBe(3);
        expect(await readFile(join(gate, "owner.json"), "utf8")).toBe(successorBytes);
        release();
        await contender;
        await withRunMaintenanceGate(root, async () => undefined);
      } finally {
        release();
        await writeFile(resume, "resume").catch(() => undefined);
        await contender?.catch(() => undefined);
        reaper.kill("SIGKILL");
        await closed;
      }
    },
    acceptanceTimeout,
  );

  it("refuses a changed observed owner before unlinking any gate entry", async () => {
    const root = await fixture();
    const gateName = ".docsfab-run-maintenance.lock";
    const gate = join(root, gateName);
    await mkdir(gate, { mode: 0o700 });
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(dead, "close");
    const ownerPath = join(gate, "owner.json");
    await writeFile(ownerPath, JSON.stringify({ pid: dead.pid, token: randomUUID() }), {
      mode: 0o600,
    });
    const input = await observedRemovalInput(root, gateName);
    const changedBytes = JSON.stringify({ pid: dead.pid, token: randomUUID() });
    await writeFile(ownerPath, changedBytes);
    const worker = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", RUN_GATE_REMOVE_WORKER],
      {
        cwd: root,
        env: { DOCSFAB_RUN_GATE_REMOVE: input, LC_ALL: "C", LANG: "C" },
        stdio: "ignore",
        timeout: limit("runs.deletionGateHelperTimeoutMs").value,
      },
    );
    expect(worker.error).toBeUndefined();
    expect(worker.status).toBe(3);
    expect(await readFile(ownerPath, "utf8")).toBe(changedBytes);
    expect((await stat(gate)).isDirectory()).toBe(true);
  });

  it("classifies a released name at the final parent observation without acting on uncertainty", async () => {
    const moduleUrl = pathToFileURL(resolve("src/records/run-maintenance-gate.ts")).href;
    for (const variant of ["gate-gone", "owner-gone", "inaccessible"] as const) {
      const root = await realpath(await fixture());
      await oneAttempt(root);
      const gate = join(root, ".docsfab-run-maintenance.lock");
      const ownerPath = join(gate, "owner.json");
      await mkdir(gate, { mode: 0o700 });
      const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(dead, "close");
      await writeFile(ownerPath, JSON.stringify({ pid: dead.pid, token: randomUUID() }), {
        mode: 0o600,
      });
      const source = `
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        const ownerPath = ${JSON.stringify(ownerPath)};
        const gatePath = ${JSON.stringify(gate)};
        const variant = ${JSON.stringify(variant)};
        const originalLstat = fs.lstat.bind(fs);
        const originalRm = fs.rm.bind(fs);
        let gateObservations = 0;
        let triggered = false;
        fs.lstat = async (...args) => {
          if (args[0] === gatePath) gateObservations += 1;
          const finalObservation = variant === "owner-gone"
            ? args[0] === ownerPath && gateObservations === 2
            : args[0] === gatePath && gateObservations === 2;
          if (!triggered && finalObservation) {
            triggered = true;
            if (variant === "inaccessible") {
              throw Object.assign(new Error("access denied"), { code: "EACCES" });
            }
            await originalRm(args[0], { recursive: variant === "gate-gone" });
          }
          return originalLstat(...args);
        };
        syncBuiltinESMExports();
        const { withRunMaintenanceGate } = await import(${JSON.stringify(moduleUrl)});
        try {
          await withRunMaintenanceGate(${JSON.stringify(root)}, async () => undefined);
          process.stdout.write(triggered ? "acquired" : "untriggered-acquired-" + gateObservations);
        } catch (error) {
          process.stdout.write(triggered ? (error?.code ?? "unknown") : "untriggered-" + (error?.code ?? "unknown") + "-" + gateObservations);
        }
      `;
      const probe = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: "utf8",
          timeout: limit("runs.deletionGateHelperTimeoutMs").value,
        },
      );
      expect(probe.error, variant).toBeUndefined();
      expect(probe.status, variant).toBe(0);
      expect(probe.stdout, variant).toBe(
        variant === "gate-gone" ? "acquired" : variant === "owner-gone" ? "held" : "unsafe",
      );
      expect((await stat(gate).catch(() => undefined)) !== undefined, variant).toBe(
        variant !== "gate-gone",
      );
      expect((await lstat(ownerPath).catch(() => undefined)) !== undefined, variant).toBe(
        variant === "inaccessible",
      );
    }
  });
});
