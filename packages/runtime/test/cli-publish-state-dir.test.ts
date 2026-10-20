// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { resolveDocsFabStateDirectory } from "../src/config/host-paths.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  parseLocalUserPublishCliOptions,
  runLocalUserPublishPreflightCli,
  runLocalUserPublishCli,
} from "../src/delivery/cli.js";
import { LocalUserPublicationPreflightError } from "../src/delivery/contracts.js";
import { handleShipCommand } from "../src/cli/commands/ship.js";
import {
  loadVerifiedPublicationRun,
  reloadVerifiedPublicationRun,
  loadVerifiedCheckoutRun,
  rejectStateDirectoryParentOfRunStore,
} from "../src/delivery/preflight.js";
import { defaultRunRecordPath } from "../src/operator/index.js";
import { FileRunStore } from "../src/records/file-store.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const execFile = promisify(execFileCallback);

const readRace = vi.hoisted(() => ({
  removeBeforeOpen: undefined as string | undefined,
  removed: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[0] === readRace.removeBeforeOpen) {
        readRace.removeBeforeOpen = undefined;
        await actual.unlink(String(args[0]));
        readRace.removed += 1;
      }
      return actual.open(...args);
    },
  };
});

describe("publish default state directory vs run store", () => {
  it("keeps checkout absence separate from publication missing-run guidance", async () => {
    const root = await roots.create("docsfab-checkout-missing-");
    const path = join(root, "absent.json");
    await expect(loadVerifiedPublicationRun(path, "absent")).rejects.toMatchObject({
      code: "saved-run-not-found",
    });
    await expect(loadVerifiedCheckoutRun(path, "absent")).rejects.toMatchObject({
      code: "invalid-run-record",
    });
    await expect(reloadVerifiedPublicationRun(path, "absent")).rejects.toMatchObject({
      code: "invalid-run-record",
    });
  });

  it("preserves invalid-run-record for removal after the initial presence observation", async () => {
    const root = await roots.create("docsfab-publication-read-race-");
    const path = await writePublishableRun(root, join(root, "runs"), "run-1");
    const before = readRace.removed;
    readRace.removeBeforeOpen = path;
    try {
      await expect(loadVerifiedPublicationRun(path, "run-1")).rejects.toMatchObject({
        code: "invalid-run-record",
      });
      expect(readRace.removed).toBe(before + 1);
    } finally {
      readRace.removeBeforeOpen = undefined;
    }
  });

  it.each([
    "malformed",
    "insecure",
    "foreign",
    "contract-gap",
    "symlink",
    "dangling-link",
  ] as const)("preserves the refusal for a present %s record", async (variant) => {
    const root = await roots.create("docsfab-present-publication-");
    const store = join(root, "runs");
    const path = await writePublishableRun(root, store, "run-1");
    const bytes = await readFile(path, "utf8");
    if (variant === "malformed") await writeFile(path, "{not-json}", { mode: 0o600 });
    if (variant === "insecure") await chmod(path, 0o644);
    if (variant === "foreign")
      await writeFile(path, bytes.replace('"id":"run-1"', '"id":"other"'), { mode: 0o600 });
    if (variant === "contract-gap")
      await writeFile(path, '{"schemaVersion":2,"id":"run-1","status":"succeeded"}', {
        mode: 0o600,
      });
    if (variant === "symlink" || variant === "dangling-link") {
      const target = join(root, "record-target.json");
      if (variant === "symlink") await writeFile(target, bytes, { mode: 0o600 });
      await rm(path);
      await symlink(target, path);
    }
    await expect(loadVerifiedPublicationRun(path, "run-1")).rejects.toMatchObject({
      code: variant === "contract-gap" ? "run-record-contract-gap" : "invalid-run-record",
    });
  });

  it("does not let a missing leaf conceal a substituted selected-store ancestor", async () => {
    const root = await roots.create("docsfab-missing-linked-store-");
    const actual = join(root, "actual");
    await mkdir(actual, { mode: 0o700 });
    const selected = join(root, "selected");
    await symlink(actual, selected);
    await expect(
      loadVerifiedPublicationRun(join(selected, "absent.json"), "absent"),
    ).rejects.toMatchObject({ code: "invalid-run-record" });
  });

  it("diagnoses an absent store without creating it", async () => {
    const root = await roots.create("docsfab-missing-store-");
    const store = join(root, "not-created", "runs");
    await expect(
      loadVerifiedPublicationRun(join(store, "absent.json"), "absent"),
    ).rejects.toMatchObject({ code: "saved-run-not-found" });
    await expect(access(join(root, "not-created"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe.each(["ship", "publish"] as const)("missing saved run through %s", (surface) => {
    it.each(["never-existing", "deleted"] as const)(
      "reports a %s record without delivery effects",
      async (variant) => {
        const root = await roots.create("docsfab-missing-publication-");
        const store = join(root, "runs");
        const path = await writePublishableRun(root, store, "run-1");
        await expect(loadVerifiedPublicationRun(path, "run-1")).resolves.toMatchObject({
          id: "run-1",
        });
        if (variant === "deleted") await rm(path);
        const runId = variant === "deleted" ? "run-1" : "never-existing";
        const effect = vi.fn(async () => {
          throw new Error("A missing run reached delivery.");
        });
        const log = vi.fn();
        const dependencies = {
          cwd: root,
          stateDirectory: store,
          commands: { run: effect },
          preflight: effect,
          submit: effect,
          execute: effect,
          log,
          stderr: vi.fn(),
        };
        const pending =
          surface === "ship"
            ? handleShipCommand([runId, "--repo", join(root, "repository")], dependencies)
            : runLocalUserPublishCli(
                [runId, "--repo", join(root, "repository"), "--draft-mr"],
                dependencies,
              );
        const error = await pending.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(LocalUserPublicationPreflightError);
        expect(error).toMatchObject({ code: "saved-run-not-found" });
        expect((error as Error).message).not.toContain("Select an intact");
        expect(effect).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
      },
    );
  });

  it("loads a run-store record without --state-dir when DOCSFAB_STATE_DIR is unset", async () => {
    const configRoot = await roots.create("docsfab-publish-state-");
    const cwdStore = resolve(process.cwd(), ".docsfab", "runs");
    const stateDirectory = resolveDocsFabStateDirectory({
      DOCSFAB_CONFIG_ROOT: configRoot,
    });
    expect(stateDirectory).toBe(resolve(configRoot, ".docsfab", "runs"));
    expect(stateDirectory).not.toBe(cwdStore);

    await new FileRunStore(stateDirectory).save(record("run-1"));
    const recordPath = defaultRunRecordPath(stateDirectory, "run-1");
    await access(recordPath);

    const options = parseLocalUserPublishCliOptions(
      ["run-1", "--repo", ".", "--draft-mr", "--preflight"],
      { cwd: "/workspace", stateDirectory },
    );
    expect(options.stateDirectory).toBe(stateDirectory);
    expect(defaultRunRecordPath(options.stateDirectory, options.runId)).toBe(recordPath);
    await access(defaultRunRecordPath(options.stateDirectory, options.runId));
  });

  it("keeps --state-dir as an override of the run store default", async () => {
    const root = await roots.create("docsfab-publish-state-override-");
    const override = join(root, "custom-runs");
    const options = parseLocalUserPublishCliOptions(
      ["run-1", "--repo", ".", "--draft-mr", "--preflight", "--state-dir", override],
      {
        cwd: "/workspace",
        stateDirectory: resolveDocsFabStateDirectory({
          DOCSFAB_CONFIG_ROOT: join(root, "config"),
        }),
      },
    );
    expect(options.stateDirectory).toBe(resolve(override));
    expect(options.stateDirectory).not.toBe(resolve(join(root, "config"), ".docsfab", "runs"));
  });

  it("loads an intact run-store record when --state-dir names that store", async () => {
    const root = await roots.create("docsfab-publish-state-store-");
    const store = join(root, "runs");
    const recordPath = await writePublishableRun(root, store, "run-1");
    const options = parseLocalUserPublishCliOptions(
      ["run-1", "--repo", ".", "--draft-mr", "--preflight", "--state-dir", store],
      {
        cwd: "/workspace",
        stateDirectory: resolveDocsFabStateDirectory({
          DOCSFAB_CONFIG_ROOT: join(root, "config"),
        }),
      },
    );
    expect(options.stateDirectory).toBe(resolve(store));
    expect(defaultRunRecordPath(options.stateDirectory, options.runId)).toBe(recordPath);
    const loaded = await loadVerifiedPublicationRun(recordPath, "run-1");
    expect(loaded.id).toBe("run-1");
    expect(loaded.sourcePath).toBe(join(root, "repository"));
  });

  it("names the selected parent when --state-dir is the run-store parent", async () => {
    const parent = await roots.create("docsfab-publish-state-parent-");
    const store = join(parent, "runs");
    await writePublishableRun(parent, store, "run-1");
    await expect(
      runLocalUserPublishPreflightCli(
        ["run-1", "--repo", ".", "--draft-mr", "--preflight", "--state-dir", parent],
        { cwd: "/workspace", stateDirectory: store, log: () => undefined },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(LocalUserPublicationPreflightError);
      const preflightError = error as LocalUserPublicationPreflightError;
      const selectedDirectory = preflightError.details?.selectedDirectory;
      expect(preflightError.code).toBe("state-directory-not-run-store");
      expect(selectedDirectory).toEqual(expect.any(String));
      expect(selectedDirectory).toContain("docsfab-publish-state-parent-");
      expect(preflightError.message).toContain(`Selected directory ${selectedDirectory}.`);
      expect(JSON.stringify(preflightError)).toContain(selectedDirectory);
      if (/^\/(?:home|Users|root)(?:\/|$)/u.test(parent)) {
        expect(preflightError.message).not.toContain(parent);
        expect(JSON.stringify(preflightError)).not.toContain(parent);
      }
      const message = preflightError.message;
      expect(message).toContain("run-store directory, not its parent");
      expect(message).not.toContain("invalid-run-record");
      expect(message).not.toContain("Select an intact DocsFab schema-v2 run record");
      return true;
    });
  });

  it("names the selected config-root when --state-dir is above .docsfab/runs", async () => {
    const configRoot = await roots.create("docsfab-publish-state-config-");
    const store = join(configRoot, ".docsfab", "runs");
    await writePublishableRun(configRoot, store, "run-1");
    await expect(
      runLocalUserPublishPreflightCli(
        ["run-1", "--repo", ".", "--draft-mr", "--preflight", "--state-dir", configRoot],
        { cwd: "/workspace", stateDirectory: store, log: () => undefined },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(LocalUserPublicationPreflightError);
      const preflightError = error as LocalUserPublicationPreflightError;
      const selectedDirectory = preflightError.details?.selectedDirectory;
      expect(preflightError.code).toBe("state-directory-not-run-store");
      expect(selectedDirectory).toEqual(expect.any(String));
      expect(selectedDirectory).toContain("docsfab-publish-state-config-");
      expect(preflightError.message).toContain(`Selected directory ${selectedDirectory}.`);
      expect(JSON.stringify(preflightError)).toContain(selectedDirectory);
      if (/^\/(?:home|Users|root)(?:\/|$)/u.test(configRoot)) {
        expect(preflightError.message).not.toContain(configRoot);
        expect(JSON.stringify(preflightError)).not.toContain(configRoot);
      }
      return true;
    });
  });

  it("does not diagnose a permissive shallow record as an intact nested store", async () => {
    const parent = await roots.create("docsfab-publish-state-stub-");
    const store = join(parent, "runs");
    const recordPath = join(store, "run-1.json");
    await mkdir(store, { recursive: true, mode: 0o700 });
    await writeFile(recordPath, '{"schemaVersion":2,"id":"run-1"}\n', { mode: 0o644 });
    await chmod(recordPath, 0o644);
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();
  });

  it("probes only the documented nested layouts", async () => {
    const parent = await roots.create("docsfab-publish-state-custom-");
    await writePublishableRun(parent, join(parent, "custom-store"), "run-1");
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();
  });

  it("preserves direct selected-path precedence over nested diagnosis", async () => {
    const parent = await roots.create("docsfab-publish-state-direct-");
    await writePublishableRun(parent, join(parent, "runs"), "run-1");
    await writeFile(join(parent, "run-1.json"), "{not-json}\n", { mode: 0o600 });
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();
  });

  it("does not follow nested store or record symlinks", async () => {
    const parent = await roots.create("docsfab-publish-state-link-");
    const realStore = join(parent, "real-store");
    await writePublishableRun(parent, realStore, "run-1");
    await symlink(realStore, join(parent, "runs"));
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();

    await rm(join(parent, "runs"));
    const store = join(parent, "runs");
    await mkdir(store, { mode: 0o700 });
    await symlink(join(realStore, "run-1.json"), join(store, "run-1.json"));
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();
  });

  it("does not diagnose a complete record whose embedded id differs", async () => {
    const parent = await roots.create("docsfab-publish-state-wrong-id-");
    const store = join(parent, "runs");
    const recordPath = await writePublishableRun(parent, store, "run-1");
    const original = await readFile(recordPath, "utf8");
    await writeFile(recordPath, original.replace('"id":"run-1"', '"id":"run-2"'), { mode: 0o600 });
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();
  });

  it("does not follow a substituted .docsfab ancestor", async () => {
    const parent = await roots.create("docsfab-publish-state-ancestor-");
    const external = await roots.create("docsfab-publish-state-external-");
    await writePublishableRun(external, join(external, ".docsfab", "runs"), "run-1");
    await symlink(join(external, ".docsfab"), join(parent, ".docsfab"));
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();
  });

  it("does not follow a symlink above the selected directory", async () => {
    const parent = await roots.create("docsfab-publish-state-above-");
    const external = await roots.create("docsfab-publish-state-above-target-");
    const target = join(external, "selected");
    await writePublishableRun(target, join(target, "runs"), "run-1");
    await symlink(external, join(parent, "link"));
    await expect(
      rejectStateDirectoryParentOfRunStore(join(parent, "link", "selected"), "run-1"),
    ).resolves.toBeUndefined();
  });

  it("does not diagnose malformed or oversized candidate records", async () => {
    const parent = await roots.create("docsfab-publish-state-invalid-");
    const store = join(parent, "runs");
    await mkdir(store, { mode: 0o700 });
    await writeFile(join(store, "run-1.json"), "{not-json}\n", { mode: 0o600 });
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();
    await writeFile(join(store, "run-1.json"), Buffer.alloc(10 * 1024 * 1024 + 1), { mode: 0o600 });
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();
  });

  it("does not open a special-file candidate", async () => {
    const parent = await roots.create("docsfab-publish-state-fifo-");
    const store = join(parent, "runs");
    await mkdir(store, { mode: 0o700 });
    await execFile("mkfifo", [join(store, "run-1.json")]);
    await expect(rejectStateDirectoryParentOfRunStore(parent, "run-1")).resolves.toBeUndefined();
  });
});

function record(id: string): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "readiness",
    repository: {
      sourcePath: "/operator/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-03T20:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
}

async function writePublishableRun(root: string, store: string, runId: string): Promise<string> {
  const repository = join(root, "repository");
  await mkdir(repository, { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  await writeFile(join(repository, "README.md"), "unchanged\n");
  const patchPath = join(store, `${runId}.patch`);
  const patch = Buffer.from("diff --git a/README.md b/README.md\n", "utf8");
  await writeFile(patchPath, patch, { mode: 0o600 });
  const recordPath = join(store, `${runId}.json`);
  const revision = "a".repeat(40);
  await writeFile(
    recordPath,
    `${JSON.stringify({
      schemaVersion: 2,
      id: runId,
      workflow: "site-bootstrap",
      repository: {
        sourcePath: repository,
        requestedRevision: "HEAD",
        revision,
      },
      workspace: { strategy: "tracked-export", disposable: true },
      task: {
        kind: "site-bootstrap",
        plan: {
          kind: "ia-plan",
          schemaVersion: 1,
          digest: "a".repeat(64),
          repositoryRevision: revision,
          repositoryContentDigest: "b".repeat(64),
        },
      },
      status: "succeeded",
      createdAt: "2026-08-04T00:00:00.000Z",
      startedAt: "2026-08-04T00:00:01.000Z",
      completedAt: "2026-08-04T00:00:02.000Z",
      durationMs: 1000,
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      securityScan: {
        ruleSet: "credential-rules-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      },
      securityScanEffectiveDisposition: { status: "passed" },
      artifacts: [
        {
          role: "input",
          stepId: "apply-site-bootstrap",
          reference: {
            kind: "ia-plan",
            schemaVersion: 1,
            digest: "a".repeat(64),
            repositoryRevision: revision,
            repositoryContentDigest: "b".repeat(64),
          },
        },
      ],
      steps: [
        {
          id: "apply-site-bootstrap",
          title: "Apply approved site bootstrap",
          kind: "host-operation",
          operation: "site-bootstrap",
          skill: "template-scaffold-site",
          mode: "write",
          status: "succeeded",
          startedAt: "2026-08-04T00:00:01.000Z",
          completedAt: "2026-08-04T00:00:02.000Z",
          durationMs: 1000,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
          tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
          contextPreflight: {
            status: "ready",
            packetDigest: "c".repeat(64),
            consultedNodeIds: ["node-a"],
            ontologyVersion: "ontology-v1",
            effectiveDecisionIds: [],
            measurements: {
              byteLength: 1,
              estimatedTokens: 1,
              latencyMs: 0,
              nodeCount: 1,
              edgeCount: 0,
              pathCount: 1,
            },
            cache: { disposition: "miss", keyDigest: "d".repeat(64), rebuildAttempted: true },
          },
          artifacts: [
            {
              role: "input",
              stepId: "apply-site-bootstrap",
              reference: {
                kind: "ia-plan",
                schemaVersion: 1,
                digest: "a".repeat(64),
                repositoryRevision: revision,
                repositoryContentDigest: "b".repeat(64),
              },
            },
          ],
          summary: "Applied approved site plan.",
        },
      ],
      changes: {
        files: [{ path: "README.md", status: "modified" }],
        patch: {
          sha256: createHash("sha256").update(patch).digest("hex"),
          byteLength: patch.byteLength,
          lineCount: 1,
          artifactPath: patchPath,
          format: "git-diff",
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  return recordPath;
}
