// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  link,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { FileConfinement } from "../src/harness/confined-tools/file-confinement.js";
import { parseCredentialSafeGrepRequest } from "../src/harness/credential-safe-grep-worker.js";
import { QualityValidatorHost } from "../src/evaluation-report/quality-validator-host.js";
import * as childRunner from "../src/evaluation-report/quality-validator-host/bounded-child.js";
import {
  qualityExecutionPath,
  withQualityGrepPolicy,
} from "../src/quality-pack/resource-access.js";
import {
  HISTORICAL_QUALITY_PROGRAM as historical,
  QUALITY_EXECUTION_RESOURCES,
  qualityExecutionResource,
} from "../src/quality-pack/resource-roles.js";
import {
  readVerifiedQualityPackFiles,
  verifyQualityPackContext,
} from "../src/quality-pack/manifest.js";
import { JS_ONLY_DIST_MODULES } from "../scripts/js-only-dist-modules.mjs";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
// Match the existing real SDK transport integration allowance; product limits stay unchanged.
const SDK_PROCESS_TEST_TIMEOUT_MS = 30_000;
const runtime = resolve(import.meta.dirname, "..");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
let program: Buffer;
let pack: Awaited<ReturnType<typeof verifyQualityPackContext>>;
let currentManifestSha256: string;
let currentQualityLockSha256: string;

beforeAll(async () => {
  [program, pack, currentManifestSha256, currentQualityLockSha256] = await Promise.all([
    readFile(join(runtime, "quality", historical.qualityPath)),
    verifyQualityPackContext({
      qualityDirectory: join(runtime, "quality"),
      qualityPackDirectory: join(runtime, "quality-pack"),
      skillCrateDirectory: join(runtime, "skill-crate"),
    }),
    readFile(join(runtime, "quality-pack/manifest.json")).then(hash),
    readFile(join(runtime, "quality/lock.json")).then(hash),
  ]);
});

async function mountFixture(source = false) {
  const root = await roots.create("docsfab-historical-resource-");
  const workspace = join(root, "workspace");
  const quality = source ? join(workspace, "packages/runtime/quality") : join(root, "quality");
  await mkdir(join(quality, "checks"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(join(workspace, ".git"));
  const original = join(quality, historical.qualityPath);
  await writeFile(original, program);
  await writeFile(join(quality, "checks/active.py"), "# active public marker\n");
  await writeFile(
    join(quality, "checks/validate_package_local.py"),
    "# useful same-name public marker\n",
  );
  await writeFile(join(workspace, "docs/guide.md"), "# PUBLIC MARKER\nA useful public marker\n");
  await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
  await writeFile(join(workspace, "ignored.txt"), "public marker in ignored input\n");
  await symlink(original, join(quality, "checks/symbolic.py"));
  await link(original, join(quality, "checks/hard.py"));
  await writeFile(join(quality, "checks/copied[identity].py"), program);
  if (source) {
    const canonical = join(workspace, "packages/quality", historical.qualitySourcePath);
    await mkdir(resolve(canonical, ".."), { recursive: true });
    await writeFile(canonical, program);
    await writeFile(join(workspace, "source-alias.py"), program);
    await writeFile(join(workspace, "validate_package.py"), "# unrelated public marker\n");
  }
  const confinement = await FileConfinement.create({
    workspacePath: workspace,
    governedQualityDirectory: quality,
  });
  const toolSet = await createConfinedToolSet({
    workspacePath: workspace,
    allowWrite: false,
    governedQualityDirectory: quality,
    credentialSafeGrepWorker: true,
  });
  const call = async (name: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const tool = toolSet.definitions.find((candidate) => candidate.name === name)!;
    const controller = new AbortController();
    onTestFinished(() => controller.abort());
    const result = await tool.execute(
      `historical-${name}`,
      params,
      signal ?? controller.signal,
      undefined,
      undefined as never,
    );
    return result.content
      .filter((item) => item.type === "text")
      .map((item) => (item as { text: string }).text)
      .join("\n");
  };
  return {
    root,
    workspace: await realpath(workspace),
    quality: await realpath(quality),
    original: await realpath(original),
    confinement,
    call,
  };
}

describe("historical quality resource identity and verified payload boundary", () => {
  it("keeps the retained program and distributed role declaration immutable", () => {
    expect(program.byteLength).toBe(historical.byteLength);
    expect(hash(program)).toBe(historical.sha256);
    expect(Object.isFrozen(historical)).toBe(true);
    expect(Object.isFrozen(historical.policy)).toBe(true);
    expect(JS_ONLY_DIST_MODULES).toContainEqual(["quality-pack", "resource-roles.js"]);
    expect(JS_ONLY_DIST_MODULES).toContainEqual(["quality-pack", "resource-roles.d.ts"]);
  });

  it("keeps full current pack authentication but excludes the historical bar from cached and re-read product payloads", async () => {
    expect(pack.evidence.qualityLockSha256).toBe(currentQualityLockSha256);
    expect(pack.evidence.manifestSha256).toBe(currentManifestSha256);
    expect(pack.evidence.barIds).toContain(historical.barId);
    for (const context of [pack, { ...pack }]) {
      await expect(
        readVerifiedQualityPackFiles(context, historical.qualityPath),
      ).rejects.toMatchObject({ code: "historical-program" });
      const checks = await readVerifiedQualityPackFiles(context, "checks");
      expect(checks.some((file) => file.path === historical.qualityPath)).toBe(false);
      expect(checks.some((file) => file.path === qualityExecutionResource("evaluation").path)).toBe(
        true,
      );
      expect(
        (await readVerifiedQualityPackFiles(context, "formats/template-set-v1")).length,
      ).toBeGreaterThan(0);
    }
    const copyPath = "checks/unregistered-historical-copy.py";
    const aliasContext = {
      ...pack,
      qualityLock: {
        ...pack.qualityLock,
        files: [...pack.qualityLock.files, { path: copyPath, sha256: historical.sha256 }],
      },
    };
    await expect(readVerifiedQualityPackFiles(aliasContext, copyPath)).rejects.toMatchObject({
      code: "historical-program",
    });
    expect(
      (await readVerifiedQualityPackFiles(aliasContext, "checks")).some(
        (file) => file.path === copyPath,
      ),
    ).toBe(false);
  });

  it("rejects a third-path program copy even when a different policy lock authenticates it", async () => {
    const root = await roots.create("docsfab-historical-registered-copy-");
    for (const directory of ["quality", "quality-pack", "skill-crate"])
      await cp(join(runtime, directory), join(root, directory), { recursive: true });
    const lock = JSON.parse(await readFile(join(root, "quality/lock.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(root, "quality-pack/manifest.json"), "utf8"));
    const path = "checks/new-copy.py";
    await writeFile(join(root, "quality", path), program);
    lock.files.push({ path, sha256: historical.sha256 });
    lock.files.sort((left: { path: string }, right: { path: string }) =>
      left.path.localeCompare(right.path),
    );
    lock.bundleSha256 = hash(
      lock.files
        .map((file: { path: string; sha256: string }) => `${file.sha256}  ${file.path}\n`)
        .join(""),
    );
    const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
    manifest.quality.lockSha256 = hash(lockBytes);
    manifest.quality.bundleSha256 = lock.bundleSha256;
    manifest.bindingSha256 = hash(
      `${manifest.skillCrate.lockSha256}\n${manifest.quality.lockSha256}\n`,
    );
    await writeFile(join(root, "quality/lock.json"), lockBytes);
    await writeFile(
      join(root, "quality-pack/manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await expect(
      verifyQualityPackContext({
        qualityDirectory: join(root, "quality"),
        qualityPackDirectory: join(root, "quality-pack"),
        skillCrateDirectory: join(root, "skill-crate"),
      }),
    ).rejects.toMatchObject({ code: "invalid-lock" });
  });

  it.each(["changed", "missing", "extra-copy"])(
    "still checks the complete file set and every historical byte: %s",
    async (mutation) => {
      const root = await roots.create("docsfab-historical-pack-");
      await cp(join(runtime, "quality"), join(root, "quality"), { recursive: true });
      await cp(join(runtime, "quality-pack"), join(root, "quality-pack"), { recursive: true });
      await cp(join(runtime, "skill-crate"), join(root, "skill-crate"), { recursive: true });
      const path = join(root, "quality", historical.qualityPath);
      if (mutation === "changed")
        await writeFile(path, Buffer.concat([program, Buffer.from("\n# drift\n")]));
      else if (mutation === "missing") await rm(path);
      else await writeFile(join(root, "quality/checks/unregistered-copy.py"), program);
      await expect(
        verifyQualityPackContext({
          qualityDirectory: join(root, "quality"),
          qualityPackDirectory: join(root, "quality-pack"),
          skillCrateDirectory: join(root, "skill-crate"),
        }),
      ).rejects.toMatchObject({
        code: mutation === "changed" ? "checksum-mismatch" : "file-set-mismatch",
      });
      expect(hash(await readFile(join(runtime, "quality", historical.qualityPath)))).toBe(
        historical.sha256,
      );
    },
  );
});

describe("historical quality resource mounted read boundary", () => {
  it.each([false, true])(
    "keeps listings useful with a dangling entry while retaining direct-read errors (source=%s)",
    async (source) => {
      const { quality, confinement, call } = await mountFixture(source);
      const dangling = join(quality, "checks/dangling.py");
      await symlink("missing.py", dangling);

      await expect(confinement.readTarget(dangling)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await confinement.isVisibleReadEntry(dangling)).toBe(false);
      const entries = await confinement.readDirectory(join(quality, "checks"));
      expect(entries).toContain("active.py");
      expect(entries).toContain("validate_package_local.py");
      for (const name of [
        "dangling.py",
        "validate_package.py",
        "symbolic.py",
        "hard.py",
        "copied[identity].py",
      ])
        expect(entries).not.toContain(name);
      for (const [name, params] of [
        ["ls", { path: ".docsfab-governed-assets/quality/checks" }],
        ["find", { path: ".docsfab-governed-assets/quality", pattern: "**/*.py" }],
      ] as const) {
        const output = await call(name, params);
        expect(output).toContain("active.py");
        expect(output).not.toContain("dangling.py");
        expect(output).not.toContain("validate_package.py");
        expect(output).not.toContain("symbolic.py");
      }
      await expect(
        confinement.readTarget(join(quality, "checks/symbolic.py")),
      ).rejects.toMatchObject({
        refusal: "governed-asset",
      });
    },
  );

  it.each(["EACCES", "EIO", "ELOOP", "ENOTDIR"])(
    "retains unexpected %s failures during entry visibility",
    async (code) => {
      const { quality, confinement } = await mountFixture();
      const error = Object.assign(new Error("independent visibility I/O control"), { code });
      const read = vi.spyOn(confinement, "readTarget").mockRejectedValueOnce(error);
      try {
        await expect(
          confinement.isVisibleReadEntry(join(quality, "checks/active.py")),
        ).rejects.toBe(error);
      } finally {
        read.mockRestore();
      }
    },
  );

  it("refuses canonical/virtual/direct/symbolic/hard/copy aliases while keeping ordinary reads and listings", async () => {
    const { quality, confinement, call } = await mountFixture();
    const paths = [
      historical.qualityPath,
      "checks/symbolic.py",
      "checks/hard.py",
      "checks/copied[identity].py",
    ];
    for (const path of paths) {
      await expect(confinement.readTarget(join(quality, path))).rejects.toMatchObject({
        refusal: "governed-asset",
      });
      await expect(
        call("read", { path: `.docsfab-governed-assets/quality/${path}` }),
      ).rejects.toThrow(/identity|governed/u);
    }
    const listing = await call("ls", { path: ".docsfab-governed-assets/quality/checks" });
    const found = await call("find", {
      path: ".docsfab-governed-assets/quality",
      pattern: "**/*.py",
    });
    for (const output of [listing, found]) {
      expect(output).toContain("active.py");
      expect(output).toContain("validate_package_local.py");
      for (const path of paths) expect(output).not.toContain(path.split("/").at(-1)!);
    }
    expect(
      await call("read", { path: ".docsfab-governed-assets/quality/checks/active.py" }),
    ).toContain("public marker");
  });

  it.each([{}, { glob: "*.py" }, { glob: "**/*", context: 1 }])(
    "keeps recursive directory grep useful with late caller glob options %j",
    async (options) => {
      const { call } = await mountFixture();
      const output = await call("grep", {
        path: ".docsfab-governed-assets/quality",
        pattern: "public marker|REQUIRED_FILES",
        ...options,
      });
      expect(output).toContain("checks/active.py:1:");
      expect(output).toContain("checks/validate_package_local.py:1:");
      expect(output).not.toContain("REQUIRED_FILES");
      expect(output).not.toContain("copied[identity]");
      expect(output).not.toContain("docsfab-quality-grep-");
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "protects both declared source paths and copies through ancestor workspace search without hiding same-name source",
    async () => {
      const { workspace, quality, call, confinement } = await mountFixture(true);
      const canonical = join(workspace, "packages/quality", historical.qualitySourcePath);
      for (const path of [
        canonical,
        join(quality, historical.qualityPath),
        join(workspace, "source-alias.py"),
      ]) {
        await expect(confinement.readTarget(path)).rejects.toMatchObject({
          refusal: "governed-asset",
        });
      }
      const before = await stat(canonical);
      const ownedBefore = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("docsfab-quality-grep-"),
      );
      const output = await call("grep", {
        path: ".",
        pattern: "public marker|REQUIRED_FILES",
        ignoreCase: true,
        glob: "**/*",
      });
      expect(output).toContain("docs/guide.md:1:");
      expect(output).toContain("validate_package.py:1: # unrelated public marker");
      expect(output).not.toContain("REQUIRED_FILES");
      expect(output).not.toContain("source-alias.py");
      expect((await stat(canonical)).nlink).toBe(before.nlink);
      expect(
        (await readdir(tmpdir())).filter((name) => name.startsWith("docsfab-quality-grep-")),
      ).toEqual(ownedBefore);
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "preserves the original ignore rules for a containing source workspace",
    async () => {
      const { call } = await mountFixture(true);
      const output = await call("grep", { path: ".", pattern: "public marker", ignoreCase: true });
      expect(output).toContain("docs/guide.md");
      expect(output).not.toContain("ignored.txt");
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it.each([
    { pattern: "(", message: /regular expression/u },
    { pattern: "public", glob: "[", message: /glob/u },
  ])(
    "preserves original parser refusals %j",
    async ({ message, ...params }) => {
      const { call } = await mountFixture();
      await expect(
        call("grep", { path: ".docsfab-governed-assets/quality", ...params }),
      ).rejects.toThrow(message);
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a literal -- pattern behind the argument barrier",
    async () => {
      const { call, workspace } = await mountFixture(true);
      await writeFile(join(workspace, "docs/flags.md"), "Read the --help option.\n");
      const output = await call("grep", { path: ".", pattern: "--", literal: true, glob: "**/*" });
      expect(output).toContain("docs/flags.md:1: Read the --help option.");
      expect(output).not.toContain("packages/quality/runtime-policy");
      expect(output).not.toContain("packages/runtime/quality/checks/");
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it("refuses direct transport reconstruction and cancellation before returning historical data", async () => {
    const { workspace, call } = await mountFixture(true);
    const base = {
      schemaVersion: 1,
      type: "request",
      id: "exact",
      cwd: workspace,
      grants: { workspaceRoot: workspace },
      params: { pattern: "public" },
    };
    for (const rgExecutable of ["rg", false, null])
      expect(() => parseCredentialSafeGrepRequest({ ...base, rgExecutable })).toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(call("grep", { path: ".", pattern: "." }, controller.signal)).rejects.toThrow();
  });

  it("forwards cancellation through the streaming adapter and cleans its owned directory", async () => {
    const { root, workspace, quality, original } = await mountFixture();
    const fake = join(root, "rg-fixture");
    await writeFile(
      fake,
      `#!${process.execPath}
if (process.argv.includes("--files")) { process.stdout.write(${JSON.stringify(original + "\0")}); }
else { process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000); }
`,
      { mode: 0o700 },
    );
    const previous = process.env.PI_CODING_AGENT_DIR;
    let owned: string | undefined;
    let processId: number | undefined;
    try {
      await withQualityGrepPolicy(workspace, quality, quality, fake, undefined, async () => {
        owned = process.env.PI_CODING_AGENT_DIR;
        const controller = new AbortController();
        const child = spawn(
          join(owned!, "bin/rg"),
          ["--json", "--glob", "**/*", "--", "marker", quality],
          { stdio: ["ignore", "pipe", "pipe"], signal: controller.signal },
        );
        child.on("error", (error) => {
          if (error.name !== "AbortError") throw error;
        });
        const closed = new Promise((done) => child.on("close", done));
        try {
          const [data] = await once(child.stdout, "data");
          processId = Number(String(data).trim());
          expect(Number.isInteger(processId)).toBe(true);
          controller.abort();
          await closed;
          expect(() => process.kill(processId!, 0)).toThrow();
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await closed;
        }
      });
      expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
      await expect(stat(owned!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (processId) {
        try {
          process.kill(processId, "SIGKILL");
        } catch {
          /* Owned fixture child already settled. */
        }
      }
    }
  });
});

describe("closed quality execution and module selection", () => {
  it.each(["evaluation", "quality-score", "report-binding"])(
    "keeps the real locked Python %s entrypoint usable",
    async (selection) => {
      const root = await roots.create("docsfab-active-quality-entry-");
      const host = new QualityValidatorHost({
        selection: { pack },
        store: {},
        temporaryRoot: root,
        stateDirectory: root,
      } as ConstructorParameters<typeof QualityValidatorHost>[0]);
      const resource = qualityExecutionResource(selection);
      const scriptDigest =
        resource.scope === "quality"
          ? pack.qualityLock.files.find((file) => file.path === resource.path)!.sha256
          : pack.skillLock.skills
              .find((skill) => skill.id === resource.skillId)!
              .files.find((file) => file.path === resource.path)!.sha256;
      const rule = qualityExecutionResource("decision-policy");
      const modulePath = qualityExecutionPath("decision-policy", "module", pack);
      const moduleDigest = pack.qualityLock.files.find((file) => file.path === rule.path)!.sha256;
      const runner = host as unknown as {
        runValidator(input: Record<string, unknown>): Promise<unknown>;
      };
      await expect(
        runner.runValidator({
          validator: selection,
          scriptPath: qualityExecutionPath(selection, "script", pack),
          expectedScriptSha256: scriptDigest,
          args: ["--help"],
          inputs: [[modulePath, moduleDigest]],
          modules: [[modulePath, moduleDigest]],
          cwd: root,
        }),
      ).resolves.toMatchObject({ outcome: "passed", exitCode: 0, scriptSha256: scriptDigest });
    },
  );

  it("only resolves active named roles and refuses historical IDs, paths, wrong kinds and unknown selections", () => {
    for (const selection of [
      historical.barId,
      historical.qualityPath,
      historical.qualitySourcePath,
      "check:unknown",
      "toString",
      null,
      {},
    ]) {
      expect(() => qualityExecutionResource(selection)).toThrow(/historical|unsupported/iu);
    }
    for (const [name, role] of Object.entries(QUALITY_EXECUTION_RESOURCES)) {
      expect(Object.isFrozen(role)).toBe(true);
      expect(qualityExecutionPath(name, role.kind, pack)).toContain(role.path);
      expect(() =>
        qualityExecutionPath(name, role.kind === "script" ? "module" : "script", pack),
      ).toThrow(/unsupported/u);
    }
  });

  it("refuses unknown/historical script or module substitutions before spawning a child", async () => {
    const root = await roots.create("docsfab-historical-dispatch-");
    const host = new QualityValidatorHost({
      selection: { pack },
      store: {},
      temporaryRoot: root,
      stateDirectory: root,
    } as ConstructorParameters<typeof QualityValidatorHost>[0]);
    const runner = host as unknown as {
      runValidator(input: Record<string, unknown>): Promise<unknown>;
    };
    const spawn = vi.spyOn(childRunner, "runBoundedChild");
    const active = qualityExecutionResource("evaluation");
    const rule = qualityExecutionResource("decision-policy");
    const digest = (path: string) =>
      pack.qualityLock.files.find((file) => file.path === path)!.sha256;
    const input = {
      validator: "evaluation",
      scriptPath: resolve(pack.qualityRoot, active.path),
      expectedScriptSha256: digest(active.path),
      args: [],
      inputs: [],
      modules: [[resolve(pack.qualityRoot, rule.path), digest(rule.path)]],
      cwd: root,
    };
    try {
      for (const mutation of [
        { validator: historical.barId },
        { validator: "unknown" },
        { scriptPath: resolve(pack.qualityRoot, historical.qualityPath) },
        { modules: [[resolve(pack.qualityRoot, historical.qualityPath), historical.sha256]] },
        { modules: [] },
      ])
        await expect(runner.runValidator({ ...input, ...mutation })).rejects.toThrow(
          /historical|unsupported/iu,
        );
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });
});
