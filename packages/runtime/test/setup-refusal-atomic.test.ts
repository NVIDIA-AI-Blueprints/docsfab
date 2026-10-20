// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { requiredSecretNamesForExecutionProfile } from "../src/config/execution-profile.js";
import { limitDefinition } from "../src/config/limits.js";
import { decodeModelProfile } from "../src/config/profile-projection.js";
import {
  commitConfigurationRootChange,
  HOST_CONFIG_FILE,
  SECRETS_ENV_FILE,
  SECRETS_ENV_LOCK_FILE,
  type ConfigurationRootChange,
  writeSecretsEnvFile,
} from "../src/config/split-layout.js";
import { runSetupBootstrap } from "../src/setup/bootstrap.js";
import { INTERNAL_SETUP_EXECUTION_PROFILE } from "../src/setup/dogfood-profile.js";
import { temporaryRoots } from "./helpers/temp.js";

// Synthetic, test-only credential values, not real keys.
const MODEL_A_KEY = "model-a-test-placeholder";
const MODEL_B_KEY = "model-b-test-placeholder";
const UNREPRESENTABLE_KEY = "first-half\nsecond-half";
const NUL_KEY = `first-half${String.fromCharCode(0)}second-half`;
const ENDPOINT = "https://gateway.example.test/v1";

const temporary = temporaryRoots();

/**
 * Faults the mocked fs functions inject when set: error codes for link() and
 * copyFile(), an error code for the next lstat() of one path, and the inode
 * number and change time lstat() reports for one path, as a filesystem that
 * reuses a deleted file's inode number and keeps coarse timestamps does.
 */
const fsFaults = vi.hoisted(() => ({
  link: undefined as string | undefined,
  copyFile: undefined as string | undefined,
  lstatOnce: undefined as { path: string; code: string } | undefined,
  reusedIdentity: undefined as { path: string; ino: bigint; ctimeNs: bigint } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fault = (code: string, operation: string) =>
    Object.assign(new Error(`${code}: operation not supported on this filesystem, ${operation}`), {
      code,
    });
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (fsFaults.link) throw fault(fsFaults.link, "link");
      return actual.link(...args);
    },
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      if (fsFaults.copyFile) throw fault(fsFaults.copyFile, "copyfile");
      return actual.copyFile(...args);
    },
    lstat: async (path: string, options?: { bigint?: boolean }) => {
      if (fsFaults.lstatOnce?.path === path) {
        const { code } = fsFaults.lstatOnce;
        fsFaults.lstatOnce = undefined;
        throw Object.assign(new Error(`${code}: i/o error, lstat '${path}'`), { code });
      }
      const metadata = await actual.lstat(path, options as { bigint: false });
      if (fsFaults.reusedIdentity?.path === path) {
        const { ino, ctimeNs } = fsFaults.reusedIdentity;
        Object.assign(
          metadata,
          typeof metadata.ino === "bigint"
            ? { ino, ctimeNs }
            : { ino: Number(ino), ctimeMs: Number(ctimeNs) / 1e6 },
        );
      }
      return metadata;
    },
  };
});

afterEach(() => {
  fsFaults.link = undefined;
  fsFaults.copyFile = undefined;
  fsFaults.lstatOnce = undefined;
  fsFaults.reusedIdentity = undefined;
});

/**
 * Every entry under the root with its kind, mode, modification time, and
 * bytes, so a rewrite with identical content still shows as a change.
 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const metadata = await lstat(path);
      if (metadata.isDirectory()) {
        entries[`${relative}/`] = `directory ${metadata.mode}`;
        await walk(path, relative);
      } else if (metadata.isSymbolicLink()) {
        entries[relative] = `symlink -> ${await readlink(path)}`;
      } else {
        const bytes = await readFile(path, "base64");
        entries[relative] = `${metadata.mode} ${metadata.mtimeMs} ${bytes}`;
      }
    }
  };
  await walk(root, "");
  return entries;
}

async function pause(milliseconds = 20): Promise<void> {
  // Let any later write land on a distinguishable modification time.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function rejectionMessage(attempt: () => Promise<unknown>): Promise<string> {
  return attempt().then(
    () => "setup resolved instead of refusing",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

/** A root whose host already runs model A on an OpenAI-compatible endpoint. */
async function rootSelectingModelA(): Promise<string> {
  const root = await temporary.create("docsfab-setup-atomic-");
  const result = await runSetupBootstrap({
    model: {
      provider: "openai-compatible",
      modelId: "model-a",
      baseUrl: ENDPOINT,
      transport: "openai-chat-completions",
    },
    environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: MODEL_A_KEY },
  });
  expect(result.status).toBe("ready");
  expect(await readFile(join(root, HOST_CONFIG_FILE), "utf8")).toContain(
    "activePolicyProfile: profiles/model-a.yaml",
  );
  await pause();
  return root;
}

const modelB = {
  provider: "openai-compatible",
  modelId: "model-b",
  baseUrl: ENDPOINT,
  transport: "openai-chat-completions",
} as const;

describe("setup refusals leave the configuration root unchanged", () => {
  it("refuses an unrepresentable key for a new endpoint selection without switching the host", async () => {
    const root = await rootSelectingModelA();
    const before = await snapshotTree(root);

    const refusal = await rejectionMessage(() =>
      runSetupBootstrap({
        model: modelB,
        environment: {
          DOCSFAB_CONFIG_ROOT: root,
          COMPATIBLE_API_KEY: UNREPRESENTABLE_KEY,
        },
      }),
    );

    expect(refusal).toMatch(
      /^secrets-env-value-unrepresentable: The value for COMPATIBLE_API_KEY /u,
    );
    expect(refusal).not.toContain("half");
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("refuses an unrepresentable key for an installed profile without switching the host", async () => {
    const root = await rootSelectingModelA();
    const before = await snapshotTree(root);
    const [credentialName] = requiredSecretNamesForExecutionProfile(
      INTERNAL_SETUP_EXECUTION_PROFILE,
    );

    const refusal = await rejectionMessage(() =>
      runSetupBootstrap({
        profile: INTERNAL_SETUP_EXECUTION_PROFILE,
        environment: {
          DOCSFAB_CONFIG_ROOT: root,
          [credentialName!]: UNREPRESENTABLE_KEY,
        },
      }),
    );

    expect(refusal).toMatch(
      new RegExp(`^secrets-env-value-unrepresentable: The value for ${credentialName} `, "u"),
    );
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("refuses an unrepresentable key for a preset without switching the host", async () => {
    const root = await rootSelectingModelA();
    const before = await snapshotTree(root);

    const refusal = await rejectionMessage(() =>
      runSetupBootstrap({
        preset: "nvidia/nvidia/nemotron-3-super-v3",
        environment: {
          DOCSFAB_CONFIG_ROOT: root,
          MODEL_API_KEY: UNREPRESENTABLE_KEY,
        },
      }),
    );

    expect(refusal).toMatch(/^secrets-env-value-unrepresentable: The value for MODEL_API_KEY /u);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("refuses to replace a stored multi-line key without switching the host", async () => {
    const root = await rootSelectingModelA();
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const stored = await readFile(secretsPath, "utf8");
    await writeFile(
      secretsPath,
      stored.replace(`COMPATIBLE_API_KEY=${MODEL_A_KEY}`, 'COMPATIBLE_API_KEY="spans\nlines"'),
      { mode: 0o600 },
    );
    await pause();
    const before = await snapshotTree(root);

    const refusal = await rejectionMessage(() =>
      runSetupBootstrap({
        model: modelB,
        environment: {
          DOCSFAB_CONFIG_ROOT: root,
          COMPATIBLE_API_KEY: "model-b-test-placeholder",
        },
      }),
    );

    expect(refusal).toMatch(
      /^secrets-env-line-unsupported: The COMPATIBLE_API_KEY assignment on line \d+ /u,
    );
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("refuses at the lock wait bound without switching the host", async () => {
    const root = await rootSelectingModelA();
    const lockPath = join(root, SECRETS_ENV_LOCK_FILE);
    // A live process on this host holds the lock, so it is never taken over.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), token: "held" }),
      {
        mode: 0o600,
      },
    );
    const past = new Date(Date.now() - 86_400_000);
    await utimes(lockPath, past, past);
    const wait = limitDefinition("secrets.lockWaitMs");
    const stale = limitDefinition("secrets.lockStaleMs");
    const retry = limitDefinition("secrets.lockRetryMs");
    const waitBound = retry.value * 2;
    expect(waitBound).toBeGreaterThanOrEqual(wait.min);
    expect(stale.min).toBeLessThan(waitBound);
    const before = await snapshotTree(root);

    const refusal = await rejectionMessage(() =>
      runSetupBootstrap({
        model: modelB,
        environment: {
          DOCSFAB_CONFIG_ROOT: root,
          COMPATIBLE_API_KEY: "model-b-test-placeholder",
          [wait.override!]: String(waitBound),
          [stale.override!]: String(stale.min),
          [retry.override!]: String(retry.min),
        },
      }),
    );

    expect(refusal).toMatch(/^secrets-lock-wait-ms-bound: \d+ exceeds secrets\.lockWaitMs /u);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("creates no file when the first selection on an empty root refuses its key", async () => {
    const root = await temporary.create("docsfab-setup-atomic-fresh-");

    const refusal = await rejectionMessage(() =>
      runSetupBootstrap({
        model: modelB,
        environment: {
          DOCSFAB_CONFIG_ROOT: root,
          COMPATIBLE_API_KEY: UNREPRESENTABLE_KEY,
        },
      }),
    );

    expect(refusal).toMatch(/^secrets-env-value-unrepresentable: /u);
    expect(await readdir(root)).toEqual([]);
  });

  it("leaves the monolithic .env in place when migration refuses a stored key", async () => {
    const root = await temporary.create("docsfab-setup-atomic-migrate-");
    await writeMonolithicEnv(root, NUL_KEY);
    await pause();
    const before = await snapshotTree(root);

    const refusal = await rejectionMessage(() =>
      runSetupBootstrap({
        migrate: true,
        environment: { DOCSFAB_CONFIG_ROOT: root },
      }),
    );

    expect(refusal).toMatch(/^secrets-env-value-unrepresentable: The value for MODEL_API_KEY /u);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("restores every written file when a later step of the change fails", async () => {
    const root = await temporary.create("docsfab-setup-atomic-rollback-");
    await writeMonolithicEnv(root, MODEL_A_KEY);
    // Moving .env to .env.legacy is the last step. A directory already at
    // .env.legacy stops that step before its rename, after host.yaml, the
    // profile, and secrets.env were written.
    await mkdir(join(root, ".env.legacy"));
    await writeFile(join(root, ".env.legacy", "kept"), "kept\n");
    await pause();
    const before = await snapshotTree(root);

    const failure = await rejectionMessage(() =>
      runSetupBootstrap({
        migrate: true,
        environment: { DOCSFAB_CONFIG_ROOT: root },
      }),
    );

    expect(failure).toMatch(/\.env\.legacy is not a regular file/u);
    expect(await snapshotTree(root)).toEqual(before);
  });
});

/**
 * A model A root where every file the change touches already exists:
 * host.yaml is 0644 and secrets.env is a symbolic link, so a restore that
 * rewrote content instead of putting the original back would show.
 */
async function rootWithOriginals(): Promise<string> {
  const root = await rootSelectingModelA();
  await chmod(join(root, HOST_CONFIG_FILE), 0o644);
  await rename(join(root, SECRETS_ENV_FILE), join(root, "stored-secrets.env"));
  await symlink("stored-secrets.env", join(root, SECRETS_ENV_FILE));
  await pause();
  return root;
}

/** Replace secrets.env, the existing profile, and host.yaml, then fail on a missing rename source. */
async function failingChange(root: string): Promise<ConfigurationRootChange> {
  const profilePath = "profiles/model-a.yaml";
  const profile = decodeModelProfile(parseYaml(await readFile(join(root, profilePath), "utf8")));
  return {
    profiles: [[profilePath, { ...profile, modelId: "model-a-renamed" }]],
    host: (current) => ({ ...current!, activeJudgeProfile: "profiles/judge.yaml" }),
    secrets: { merge: () => [["COMPATIBLE_API_KEY", MODEL_B_KEY]] },
    moves: [[join(root, "missing-source"), join(root, "moved-target")]],
  };
}

/**
 * Ways another writer can change a file setup just placed. Each returns the
 * text it left. None depends on how the host numbers inodes or how finely
 * it records change times: an in-place write keeps the inode everywhere, and
 * the mocked lstat() reports the placed file's inode number and change time
 * for the recreated file.
 */
const otherWriters: ReadonlyArray<
  readonly [string, (path: string, placed: string) => Promise<string>]
> = [
  [
    "deleted and recreated under the same inode number and change time",
    async (path) => {
      const { ino, ctimeNs } = await lstat(path, { bigint: true });
      await unlink(path);
      const newer = "written by another setup\n";
      await writeFile(path, newer, { mode: 0o600 });
      fsFaults.reusedIdentity = { path, ino, ctimeNs };
      return newer;
    },
  ],
  [
    "rewrote in place with other bytes of the same size",
    async (path, placed) => {
      const newer = placed.replace("model-a-renamed", "model-z-renamed");
      expect(newer).not.toBe(placed);
      expect(newer.length).toBe(placed.length);
      await writeFile(path, newer);
      return newer;
    },
  ],
  [
    "rewrote in place with a different size",
    async (path) => {
      const newer = "written by another setup\n";
      await writeFile(path, newer);
      return newer;
    },
  ],
  [
    "rewrote in place with the same bytes",
    async (path, placed) => {
      await pause();
      await writeFile(path, placed);
      return placed;
    },
  ],
];

/** The kept original that a setup-commit-incomplete message names for path. */
function keptOriginal(failure: string, path: string): string {
  const kept = new RegExp(
    `could not restore ${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\(original kept at (\\S+\\.setup-incomplete\\.[0-9a-f-]{36}\\.bak)\\)`,
    "u",
  ).exec(failure);
  expect(kept).not.toBeNull();
  return kept![1]!;
}

describe("configuration-root change rollback", () => {
  it("puts back each original file, mode, and symbolic link when a later step fails", async () => {
    const root = await rootWithOriginals();
    const before = await snapshotTree(root);
    const written: string[] = [];

    const failure = await rejectionMessage(async () =>
      commitConfigurationRootChange(root, await failingChange(root), {
        onTemporaryWritten: (temporaryPath) => {
          written.push(temporaryPath);
        },
      }),
    );

    expect(failure).toMatch(/ENOENT/u);
    // secrets.env, the profile, and host.yaml were all replaced before the failure.
    expect(written).toHaveLength(3);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("stops with setup-commit-incomplete, naming the path, when an original cannot be put back", async () => {
    const root = await rootWithOriginals();
    const profilePath = join(root, "profiles", "model-a.yaml");
    const before = await snapshotTree(root);

    const failure = await rejectionMessage(async () =>
      commitConfigurationRootChange(root, await failingChange(root), {
        onTemporaryWritten: async (temporaryPath) => {
          if (!temporaryPath.startsWith(join(root, HOST_CONFIG_FILE))) return;
          // Lose the kept link to the original profile before the undo needs it.
          await rm(join(root, "profiles"), /^model-a\.yaml\.\d+\.[0-9a-f-]{36}\.bak$/u);
        },
      }),
    );

    expect(failure).toMatch(/^setup-commit-incomplete: Setup stopped partway /u);
    expect(failure).toContain(
      `could not restore ${profilePath} (no copy of the original remains).`,
    );
    expect(failure).not.toContain(MODEL_A_KEY);
    expect(failure).not.toContain(MODEL_B_KEY);
    // Every other original is still put back.
    const after = await snapshotTree(root);
    for (const path of [HOST_CONFIG_FILE, SECRETS_ENV_FILE, "stored-secrets.env"]) {
      expect(after[path]).toBe(before[path]);
    }
  });

  it.each(otherWriters)(
    "leaves a file that another writer %s, and keeps and names its original",
    async (_writer, changePlaced) => {
      const root = await rootWithOriginals();
      const profilePath = join(root, "profiles", "model-a.yaml");
      const original = await readFile(profilePath, "utf8");
      const before = await snapshotTree(root);
      let newer: string | undefined;

      const failure = await rejectionMessage(async () =>
        commitConfigurationRootChange(root, await failingChange(root), {
          onTemporaryWritten: async (temporaryPath) => {
            if (!temporaryPath.startsWith(join(root, HOST_CONFIG_FILE))) return;
            // The profile is already replaced; another writer changes it now.
            newer = await changePlaced(profilePath, await readFile(profilePath, "utf8"));
          },
        }),
      );

      expect(failure).toMatch(/^setup-commit-incomplete: /u);
      const kept = keptOriginal(failure, profilePath);
      expect(await readFile(profilePath, "utf8")).toBe(newer);
      expect(await readFile(kept, "utf8")).toBe(original);
      const after = await snapshotTree(root);
      for (const path of [HOST_CONFIG_FILE, SECRETS_ENV_FILE, "stored-secrets.env"]) {
        expect(after[path]).toBe(before[path]);
      }
      // A later setup's orphan cleanup keeps that original for the operator.
      await writeSecretsEnvFile(root, [["COMPATIBLE_API_KEY", MODEL_B_KEY]]);
      expect(await readFile(kept, "utf8")).toBe(original);
    },
  );

  it("stops with setup-commit-incomplete, naming the path, when a replaced file cannot be read back", async () => {
    const root = await rootWithOriginals();
    const profilePath = join(root, "profiles", "model-a.yaml");
    const original = await readFile(profilePath, "utf8");
    const before = await snapshotTree(root);

    const failure = await rejectionMessage(async () =>
      commitConfigurationRootChange(root, await failingChange(root), {
        onTemporaryWritten: (temporaryPath) => {
          if (!temporaryPath.startsWith(profilePath)) return;
          // The next lstat of the profile is the read-back right after its rename.
          fsFaults.lstatOnce = { path: profilePath, code: "EIO" };
        },
      }),
    );

    expect(failure).toMatch(/^setup-commit-incomplete: Setup stopped partway [^(]*\(EIO: /u);
    expect(await readFile(keptOriginal(failure, profilePath), "utf8")).toBe(original);
    expect(failure).not.toContain(MODEL_A_KEY);
    expect(failure).not.toContain(MODEL_B_KEY);
    const after = await snapshotTree(root);
    for (const path of [HOST_CONFIG_FILE, SECRETS_ENV_FILE, "stored-secrets.env"]) {
      expect(after[path]).toBe(before[path]);
    }
  });

  it("builds host.yaml from the file read under the lock, keeping a concurrent edit", async () => {
    const root = await rootSelectingModelA();
    const hostPath = join(root, HOST_CONFIG_FILE);
    const lockPath = join(root, SECRETS_ENV_LOCK_FILE);
    // Hold the lock as a live process on this host, so setup waits for it.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), token: "held" }),
      {
        mode: 0o600,
      },
    );

    const setup = runSetupBootstrap({
      model: modelB,
      environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: MODEL_B_KEY },
    });
    await pause(200);
    // Another setup changes host.yaml while this one waits for the lock.
    const edited = (await readFile(hostPath, "utf8")).replace(
      "stateDir: ./.docsfab/runs",
      "stateDir: ./edited-runs",
    );
    expect(edited).toContain("stateDir: ./edited-runs");
    await writeFile(hostPath, edited, { mode: 0o600 });
    await unlink(lockPath);

    expect((await setup).status).toBe("ready");
    const host = await readFile(hostPath, "utf8");
    expect(host).toContain("activePolicyProfile: profiles/model-b.yaml");
    expect(host).toContain("stateDir: ./edited-runs");
    // A completed change removes the backups it kept for an undo.
    const leftovers = [...(await readdir(root)), ...(await readdir(join(root, "profiles")))];
    expect(leftovers.filter((name) => name.endsWith(".bak"))).toEqual([]);
  });

  it("rechecks the lock before every rename and undoes the change when it is lost", async () => {
    const root = await rootWithOriginals();
    const lockPath = join(root, SECRETS_ENV_LOCK_FILE);
    const before = await snapshotTree(root);
    const change = await failingChange(root);

    const failure = await rejectionMessage(() =>
      commitConfigurationRootChange(
        root,
        { ...change, moves: [] },
        {
          onTemporaryWritten: async (temporaryPath) => {
            if (!temporaryPath.startsWith(join(root, HOST_CONFIG_FILE))) return;
            // Another writer takes the lock after secrets.env and the profile
            // were replaced, before host.yaml is.
            await writeFile(
              lockPath,
              JSON.stringify({ pid: 1, host: "other-host.invalid", token: "newer" }),
            );
          },
        },
      ),
    );

    expect(failure).toMatch(/^secrets-env-lock-lost: /u);
    const after = await snapshotTree(root);
    expect(after[SECRETS_ENV_LOCK_FILE]).toBeDefined();
    delete after[SECRETS_ENV_LOCK_FILE];
    expect(after).toEqual(before);
  });

  it("removes the kept original of a file whose rename never happened", async () => {
    const root = await rootWithOriginals();
    const lockPath = join(root, SECRETS_ENV_LOCK_FILE);
    const before = await snapshotTree(root);

    const failure = await rejectionMessage(async () =>
      commitConfigurationRootChange(root, await failingChange(root), {
        onTemporaryWritten: async (temporaryPath) => {
          if (!temporaryPath.startsWith(join(root, "profiles", "model-a.yaml"))) return;
          // The profile original is kept, then the lock is lost before its rename.
          await writeFile(
            lockPath,
            JSON.stringify({ pid: 1, host: "other-host.invalid", token: "newer" }),
          );
        },
      }),
    );

    expect(failure).toMatch(
      /^secrets-env-lock-lost: .*put back the files it had already replaced/u,
    );
    const after = await snapshotTree(root);
    delete after[SECRETS_ENV_LOCK_FILE];
    expect(after).toEqual(before);
  });

  it("does not add missing names to an existing secrets.env when no key is supplied", async () => {
    const root = await rootSelectingModelA();
    const secretsPath = join(root, SECRETS_ENV_FILE);
    const required = requiredSecretNamesForExecutionProfile(INTERNAL_SETUP_EXECUTION_PROFILE);
    const stored = (await readFile(secretsPath, "utf8"))
      .split("\n")
      .filter((line) => !required.some((name) => line.startsWith(`${name}=`)))
      .join("\n");
    await writeFile(secretsPath, stored, { mode: 0o600 });
    await pause();
    const before = await snapshotTree(root);

    const result = await runSetupBootstrap({
      profile: INTERNAL_SETUP_EXECUTION_PROFILE,
      environment: { DOCSFAB_CONFIG_ROOT: root },
    });

    expect(result.status).toBe("blocked-missing-credential");
    expect((await snapshotTree(root))[SECRETS_ENV_FILE]).toBe(before[SECRETS_ENV_FILE]);
  });
});

describe("configuration roots whose filesystem cannot hard-link", () => {
  it("switches the model with a copied backup where link() is unsupported", async () => {
    const root = await rootSelectingModelA();
    fsFaults.link = "ENOTSUP";

    const result = await runSetupBootstrap({
      model: modelB,
      environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: MODEL_B_KEY },
    });

    expect(result.status).toBe("ready");
    expect(await readFile(join(root, HOST_CONFIG_FILE), "utf8")).toContain(
      "activePolicyProfile: profiles/model-b.yaml",
    );
    expect(await readFile(join(root, SECRETS_ENV_FILE), "utf8")).toContain(
      `COMPATIBLE_API_KEY=${MODEL_B_KEY}`,
    );
    expect((await readdir(root)).filter((name) => name.endsWith(".bak"))).toEqual([]);
  });

  it("puts back copied originals with their bytes and mode when a later step fails", async () => {
    const root = await rootWithOriginals();
    const without = (tree: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(tree).map(([path, entry]) => [
          path,
          entry.replace(/^(\d+) [\d.]+ /u, "$1 "),
        ]),
      );
    const before = await snapshotTree(root);
    const mtime = async (path: string) => (await lstat(join(root, path))).mtimeMs;
    const beforeMtimes = await Promise.all([HOST_CONFIG_FILE, "profiles/model-a.yaml"].map(mtime));
    fsFaults.link = "EPERM";

    const failure = await rejectionMessage(async () =>
      commitConfigurationRootChange(root, await failingChange(root)),
    );

    expect(failure).toMatch(/ENOENT/u);
    expect(without(await snapshotTree(root))).toEqual(without(before));
    const afterMtimes = await Promise.all([HOST_CONFIG_FILE, "profiles/model-a.yaml"].map(mtime));
    afterMtimes.forEach((value, index) => {
      expect(Math.abs(value - beforeMtimes[index]!)).toBeLessThan(1);
    });
  });

  it("stops with setup-backup-failed, changing nothing, when no copy can be kept", async () => {
    const root = await rootSelectingModelA();
    const before = await snapshotTree(root);
    fsFaults.link = "ENOTSUP";
    fsFaults.copyFile = "ENOSPC";

    const refusal = await rejectionMessage(() =>
      runSetupBootstrap({
        model: modelB,
        environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: MODEL_B_KEY },
      }),
    );

    expect(refusal).toMatch(
      new RegExp(
        `^setup-backup-failed: Setup could not keep a copy of ${join(root, SECRETS_ENV_FILE).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} before replacing it \\(ENOSPC`,
        "u",
      ),
    );
    expect(refusal).toContain(`the filesystem that holds ${root}`);
    expect(refusal).toContain("then rerun docsfab setup.");
    expect(refusal).not.toContain(MODEL_A_KEY);
    expect(refusal).not.toContain(MODEL_B_KEY);
    expect(await snapshotTree(root)).toEqual(before);
  });
});

/** Remove every entry of root whose name matches pattern. */
async function rm(root: string, pattern: RegExp): Promise<void> {
  const matches = (await readdir(root)).filter((name) => pattern.test(name));
  expect(matches).toHaveLength(1);
  for (const name of matches) await unlink(join(root, name));
}

/** A legacy monolithic .env selecting one model, with the given MODEL_API_KEY. */
async function writeMonolithicEnv(root: string, apiKey: string): Promise<void> {
  await writeFile(
    join(root, ".env"),
    [
      "MODEL_PROVIDER=nvidia-inference-api",
      "MODEL_BASE_URL=https://gateway.example.test/v1",
      "MODEL_ID=nvidia/meta/llama-3.3-70b-instruct",
      "MODEL_API_FORMAT=chat_completions",
      `MODEL_API_KEY=${apiKey}`,
      "MODEL_CONTEXT_WINDOW=128000",
      "MODEL_MAX_INPUT_TOKENS=128000",
      "MODEL_MAX_OUTPUT_TOKENS=4096",
      "MODEL_API_MIN_OUTPUT_TOKENS=16",
      "MODEL_CONTEXT_RESERVE_TOKENS=4096",
      "MODEL_REASONING=false",
      "MODEL_INPUT_TYPES=text",
      "MODEL_SUPPORTS_DEVELOPER_ROLE=false",
      "MODEL_SUPPORTS_REASONING_EFFORT=false",
      "MODEL_COMPATIBLE_API_FORMATS=chat_completions",
      "MODEL_INPUT_COST_PER_MILLION=unknown",
      "MODEL_OUTPUT_COST_PER_MILLION=unknown",
      "MODEL_CACHE_READ_COST_PER_MILLION=unknown",
      "MODEL_CACHE_WRITE_COST_PER_MILLION=unknown",
      "MODEL_PROFILE_APPROVED_SOURCE=https://models.example.test/llama-3.3-70b-instruct",
      "MODEL_PROFILE_EFFECTIVE_DATE=2026-08-04",
      "MODEL_PROFILE_REVIEW_AFTER=2026-12-31",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}
