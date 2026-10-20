// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseArguments,
  publishPackage,
  readArtifact,
  resolvePublishChannel,
  resolvePublishRegistry,
} from "./publish-package.mjs";
import { downloadBoundedArchive } from "./lib/package-publication.mjs";

const execute = promisify(execFile);
const SOURCE_SHA = "436f9314436f9314436f9314436f9314436f9314";
const VERSION = "0.1.0-main.436f9314";
const REGISTRY = "https://registry.example.invalid/api/v4/projects/1/packages/npm/";
const ENV = {
  CI_JOB_TOKEN: "test-token",
  CI_COMMIT_BRANCH: "main",
  CI_DEFAULT_BRANCH: "main",
  CI_COMMIT_SHA: SOURCE_SHA,
  CI_COMMIT_SHORT_SHA: "436f9314",
  PATH: process.env.PATH,
  HOME: process.env.HOME,
};

async function fixture(root) {
  const projectRoot = join(root, "project");
  const packageRoot = join(root, "package");
  const artifactRoot = join(projectRoot, "package-artifacts");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  const sourcePackage = {
    name: "docsfab",
    version: VERSION,
    license: "UNLICENSED",
    files: ["dist", "npm-shrinkwrap.json"],
    scripts: { prepack: "node -e \"require('fs').writeFileSync('/tmp/lifecycle-ran', '1')\"" },
  };
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(sourcePackage, null, 2)}\n`);
  await writeFile(
    join(packageRoot, "npm-shrinkwrap.json"),
    `${JSON.stringify({ name: "docsfab", version: VERSION, lockfileVersion: 3, packages: { "": { name: "docsfab", version: VERSION } } }, null, 2)}\n`,
  );
  await writeFile(join(packageRoot, "dist", "launcher.js"), "#!/usr/bin/env node\n");
  await writeFile(
    join(packageRoot, "dist", "build-identity.js"),
    `export const DOCSFAB_BUILD_IDENTITY = Object.freeze(${JSON.stringify({ schemaVersion: 1, commit: SOURCE_SHA, dirty: false })});\n`,
  );
  await execute("tar", ["-czf", join(artifactRoot, "docsfab.tgz"), "-C", root, "package"]);
  const bytes = await readFile(join(artifactRoot, "docsfab.tgz"));
  const metadata = {
    schemaVersion: 2,
    artifact: "docsfab.tgz",
    filename: `docsfab-${VERSION}.tgz`,
    name: "docsfab",
    version: VERSION,
    sourceVersion: "0.1.0",
    sourceClean: true,
    sourceRevision: SOURCE_SHA,
    entryCount: 3,
    unpackedSize: 256,
    size: bytes.byteLength,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    sha1: createHash("sha1").update(bytes).digest("hex"),
  };
  await writeFile(join(artifactRoot, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "docsfab", version: "0.1.0", publishConfig: { registry: REGISTRY } }, null, 2)}\n`,
  );
  return { projectRoot, artifactRoot, bytes, metadata };
}

function recordingRun({
  archive = null,
  archiveByVersion = {},
  tags = {},
  publishFails = false,
  publishFailsWithoutStore = false,
  failPack = false,
  packError = null,
  malformedPack = false,
  overflow = null,
  oversizedPack = false,
  protectedHead = SOURCE_SHA,
  ancestorPairs = new Set(),
  outsideWriterOnFetch = false,
  malformedTags = false,
  requireAuthConfig = false,
  delayedPromotionReadbacks = 0,
  promotionReadbackFailure = null,
  archiveBodyError = null,
  delayedUploadReadbacks = 0,
  delayedUploadArchive404 = 0,
  requireOnlineReadback = false,
  postUploadReadbackFailure = null,
  postUploadArchive = null,
  metadataAlways404 = false,
  directArchiveVisibleOnMetadata404 = false,
  directArchiveStatusOnMetadata404 = null,
} = {}) {
  const calls = [];
  let stored = archive;
  let currentTags = { ...tags };
  let previousPromotionTag;
  let afterPromotion = false;
  let delayedReadsRemaining = delayedPromotionReadbacks;
  let delayedUploadReadsRemaining = delayedUploadReadbacks;
  let delayedUploadArchiveReadsRemaining = delayedUploadArchive404;
  let afterUpload = false;
  let hideDirectArchive = false;
  let directArchiveAfterMetadataMiss = false;
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (overflow === args[0]) {
      const error = new Error("private marker");
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      error.stderr = "private marker";
      throw error;
    }
    if (command === "git" && args[0] === "fetch") {
      if (outsideWriterOnFetch) currentTags.main = "0.1.0-main.bbbbbbbb";
      return { stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse") {
      return { stdout: `${protectedHead}\n`, stderr: "" };
    }
    if (command === "git" && args[0] === "merge-base") {
      if (
        args[2] === args[3] ||
        (args[2] === SOURCE_SHA && args[3] === protectedHead) ||
        ancestorPairs.has(`${args[2]}:${args[3]}`)
      ) {
        return { stdout: "", stderr: "" };
      }
      const error = new Error("not ancestor");
      error.code = 1;
      throw error;
    }
    if (
      command === "npm" &&
      args[0] === "view" &&
      args[1]?.startsWith("docsfab@") &&
      args[2] !== "dist-tags"
    ) {
      hideDirectArchive = false;
      directArchiveAfterMetadataMiss = false;
      if (requireAuthConfig && !options.env?.npm_config_userconfig) {
        const error = new Error("registry authentication config is missing");
        error.stderr = "E401 unauthorized";
        throw error;
      }
      if (afterUpload && delayedUploadReadsRemaining > 0) {
        delayedUploadReadsRemaining -= 1;
        hideDirectArchive = !directArchiveVisibleOnMetadata404;
        directArchiveAfterMetadataMiss = true;
        const error = new Error("not found");
        error.stderr = "E404 Not Found";
        throw error;
      }
      if (metadataAlways404) {
        hideDirectArchive = !directArchiveVisibleOnMetadata404;
        directArchiveAfterMetadataMiss = true;
        const error = new Error("metadata cache missing version");
        error.stderr = "E404 Not Found";
        throw error;
      }
      if (afterUpload && postUploadReadbackFailure) {
        if (postUploadReadbackFailure === "malformed") return { stdout: "not-json", stderr: "" };
        const error = new Error("exact-version metadata read failed");
        error.stderr = postUploadReadbackFailure === "authorization" ? "E403 forbidden" : "";
        error.reasonClass = postUploadReadbackFailure;
        throw error;
      }
      if (afterUpload && requireOnlineReadback && !args.includes("--prefer-online")) {
        const error = new Error("cached not found");
        error.stderr = "E404 Not Found";
        throw error;
      }
      if (failPack || packError) {
        const error = packError ?? new Error("registry unavailable");
        if (!packError) error.stderr = "E401 unauthorized";
        throw error;
      }
      if (malformedPack) return { stdout: "not an npm pack JSON response", stderr: "" };
      if (!stored) {
        const error = new Error("not found");
        error.stderr = "E404 Not Found";
        throw error;
      }
      if (oversizedPack) {
        const requestedVersion = args[1].slice("docsfab@".length);
        return {
          stdout: JSON.stringify(`${REGISTRY}docsfab/-/docsfab-${requestedVersion}.tgz`),
          stderr: "",
        };
      }
      const requestedVersion = args[1].slice("docsfab@".length);
      return {
        stdout: JSON.stringify(`${REGISTRY}docsfab/-/docsfab-${requestedVersion}.tgz`),
        stderr: "",
      };
    }
    if (command === "npm" && args[0] === "view") {
      if (args[2] === "dist-tags") {
        if (afterPromotion && promotionReadbackFailure === "timeout") {
          const error = new Error("owned channel readback deadline expired");
          error.reasonClass = "timeout";
          throw error;
        }
        if (afterPromotion && promotionReadbackFailure === "authorization") {
          const error = new Error("registry authorization denied");
          error.stderr = "E403 forbidden";
          throw error;
        }
        if (afterPromotion && promotionReadbackFailure === "malformed") {
          return { stdout: "not-json", stderr: "" };
        }
        if (afterPromotion && delayedReadsRemaining > 0) {
          delayedReadsRemaining -= 1;
          return {
            stdout: JSON.stringify({ ...currentTags, main: previousPromotionTag }),
            stderr: "",
          };
        }
        return { stdout: malformedTags ? "not-json" : JSON.stringify(currentTags), stderr: "" };
      }
      if (requireAuthConfig && !options.env?.npm_config_userconfig) {
        const error = new Error("registry authentication config is missing");
        error.stderr = "E401 unauthorized";
        throw error;
      }
      const error = new Error("unsupported npm view");
      error.stderr = "E404";
      throw error;
    }
    if (command === "npm" && args[0] === "publish") {
      if (!publishFailsWithoutStore) stored = await readFile(args[1]);
      afterUpload = true;
      if (publishFails || publishFailsWithoutStore) throw new Error("response lost");
      return { stdout: "", stderr: "" };
    }
    if (command === "npm" && args[0] === "dist-tag" && args[1] === "add") {
      previousPromotionTag = currentTags[args[3]];
      currentTags[args[3]] = VERSION;
      afterPromotion = true;
      return { stdout: "", stderr: "" };
    }
    return execute(command, args, options);
  };
  const fetchImpl = async (_url, options) => {
    calls.push({ command: "registry", args: [String(_url)], options });
    if (options.headers.authorization !== "Bearer test-token") {
      throw new Error("missing registry archive bearer token");
    }
    if (String(_url).endsWith("/-/package/docsfab/dist-tags")) {
      if (afterPromotion && promotionReadbackFailure === "timeout") {
        throw Object.assign(new Error("owned channel readback deadline expired"), {
          reasonClass: "timeout",
        });
      }
      if (afterPromotion && promotionReadbackFailure === "authorization")
        return new Response(null, { status: 403 });
      if (afterPromotion && promotionReadbackFailure === "malformed")
        return new Response("not-json", { status: 200 });
      if (afterPromotion && delayedReadsRemaining > 0) {
        delayedReadsRemaining -= 1;
        return Response.json({ ...currentTags, main: previousPromotionTag });
      }
      return malformedTags ? new Response("not-json", { status: 200 }) : Response.json(currentTags);
    }
    if (hideDirectArchive) {
      hideDirectArchive = false;
      return new Response(null, { status: 404 });
    }
    if (directArchiveAfterMetadataMiss && directArchiveStatusOnMetadata404) {
      directArchiveAfterMetadataMiss = false;
      return new Response(null, { status: directArchiveStatusOnMetadata404 });
    }
    directArchiveAfterMetadataMiss = false;
    const archiveVersion = /docsfab-([^/]+)\.tgz$/u.exec(String(_url))?.[1];
    if (afterUpload && delayedUploadArchiveReadsRemaining > 0) {
      delayedUploadArchiveReadsRemaining -= 1;
      return new Response(null, { status: 404 });
    }
    const responseArchive =
      archiveByVersion[archiveVersion] ?? (afterUpload ? postUploadArchive : null) ?? stored;
    if (!responseArchive) return new Response(null, { status: 404 });
    if (archiveBodyError) {
      const body = new ReadableStream({
        start(controller) {
          controller.error(archiveBodyError);
        },
      });
      return new Response(body, { status: 200 });
    }
    if (oversizedPack)
      return new Response(new Uint8Array(0), {
        status: 200,
        headers: { "content-length": "67108865" },
      });
    return new Response(responseArchive, { status: 200 });
  };
  run.fetchImpl = fetchImpl;
  return { run, fetchImpl, calls, getTags: () => currentTags };
}

describe("package publication", () => {
  let root;
  let item;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-publish-test-")));
    item = await fixture(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("selects stable tags exactly and excludes release cuts", () => {
    expect(resolvePublishChannel({ version: "0.1.0" }, { CI_COMMIT_TAG: "v0.1.0" })).toEqual({
      channel: "release",
      version: "0.1.0",
      distTag: "latest",
    });
    expect(() =>
      resolvePublishChannel({ version: "0.1.0" }, { CI_COMMIT_TAG: "v0.1.0-rc.1" }),
    ).toThrow(/release cut/u);
    expect(() => resolvePublishChannel({ version: "0.1.0" }, { CI_COMMIT_TAG: "v0.2.0" })).toThrow(
      /does not match/u,
    );
  });

  it("confines registry overrides to a complete HTTPS GitLab project identity", () => {
    expect(resolvePublishRegistry({ publishConfig: { registry: REGISTRY } }, {})).toBe(REGISTRY);
    expect(() =>
      resolvePublishRegistry(
        { publishConfig: { registry: REGISTRY } },
        { CI_API_V4_URL: "https://gitlab.invalid/api/v4" },
      ),
    ).toThrow(/must both be set/u);
    expect(() =>
      resolvePublishRegistry(
        { publishConfig: { registry: REGISTRY } },
        { CI_API_V4_URL: "https://gitlab.invalid/api/v4", CI_PROJECT_ID: "../other" },
      ),
    ).toThrow(/numeric GitLab project id/u);
    expect(() =>
      resolvePublishRegistry(
        { publishConfig: { registry: "https://user:password@registry.example.invalid/npm/" } },
        {},
      ),
    ).toThrow(/one https registry URL/u);
  });

  it("accepts only the exact final version, full source SHA, clean identity, and archive bytes", async () => {
    await expect(
      readArtifact(
        item.artifactRoot,
        { name: "docsfab", version: "0.1.0", publishConfig: { registry: REGISTRY } },
        ENV,
      ),
    ).resolves.toBe(join(item.artifactRoot, "docsfab.tgz"));
    await expect(
      readArtifact(
        item.artifactRoot,
        { name: "docsfab", version: "0.1.0", publishConfig: { registry: REGISTRY } },
        { ...ENV, CI_COMMIT_SHA: "f".repeat(40) },
      ),
    ).rejects.toThrow(/source revision/u);
    const changed = { ...item.metadata, sourceClean: false };
    await writeFile(join(item.artifactRoot, "metadata.json"), JSON.stringify(changed));
    await expect(
      readArtifact(
        item.artifactRoot,
        { name: "docsfab", version: "0.1.0", publishConfig: { registry: REGISTRY } },
        ENV,
      ),
    ).rejects.toThrow(/metadata name or version/u);
    await writeFile(
      join(root, "package", "dist", "build-identity.js"),
      `export const DOCSFAB_BUILD_IDENTITY = Object.freeze(${JSON.stringify({ schemaVersion: 1, commit: SOURCE_SHA, dirty: true })});\n`,
    );
    await execute("tar", ["-czf", join(item.artifactRoot, "docsfab.tgz"), "-C", root, "package"]);
    const dirtyIdentityBytes = await readFile(join(item.artifactRoot, "docsfab.tgz"));
    const cleanMetadata = {
      ...item.metadata,
      size: dirtyIdentityBytes.byteLength,
      integrity: `sha512-${createHash("sha512").update(dirtyIdentityBytes).digest("base64")}`,
      sha1: createHash("sha1").update(dirtyIdentityBytes).digest("hex"),
    };
    await writeFile(join(item.artifactRoot, "metadata.json"), JSON.stringify(cleanMetadata));
    await expect(
      readArtifact(
        item.artifactRoot,
        { name: "docsfab", version: "0.1.0", publishConfig: { registry: REGISTRY } },
        ENV,
      ),
    ).rejects.toThrow(/does not match clean source provenance/u);
  });

  it("checks the governed archive-size bound before reading a retained tarball", async () => {
    const catalog = JSON.parse(
      await readFile(new URL("../../../config/limits.catalog.json", import.meta.url), "utf8"),
    );
    const handle = await open(join(item.artifactRoot, "docsfab.tgz"), "r+");
    await handle.truncate(catalog.limits["publishPackage.registryArchiveBytes"].value + 1);
    await handle.close();
    await expect(
      readArtifact(
        item.artifactRoot,
        { name: "docsfab", version: "0.1.0", publishConfig: { registry: REGISTRY } },
        ENV,
      ),
    ).rejects.toThrow(/publish-package-registry-archive-bound/u);
  });

  it("stops a chunked registry body at the byte bound and removes the partial archive", async () => {
    const path = join(root, "partial.tgz");
    let pulls = 0;
    const body = new ReadableStream(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(3));
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      downloadBoundedArchive({
        url: `${REGISTRY}docsfab/-/docsfab-1.0.0.tgz`,
        registry: REGISTRY,
        token: "test-token",
        destination: path,
        maxBytes: 4,
        timeoutMs: 1000,
        fetchImpl: async () => new Response(body, { status: 200 }),
      }),
    ).rejects.toMatchObject({ reasonClass: "size_bound" });
    expect(pulls).toBe(2);
    await expect(access(path)).rejects.toThrow();
  });

  it("uploads accepted bytes to an immutable version and returns before channel checks", async () => {
    const fake = recordingRun();
    const result = await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    expect(result.channelState).toBe("uploaded");
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
    ).toHaveLength(1);
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toHaveLength(0);
    const publish = fake.calls.find(
      ({ command, args }) => command === "npm" && args[0] === "publish",
    );
    expect(await readFile(publish.args[1])).toEqual(item.bytes);
    expect(publish.args).toContain(`upload-${SOURCE_SHA}`);
    expect(publish.args).toContain("--ignore-scripts");
    expect(
      fake.calls.some(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toBe(false);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt).toMatchObject({
      sourceRevision: SOURCE_SHA,
      version: VERSION,
      integrity: item.metadata.integrity,
      size: item.bytes.byteLength,
      upload: { state: "uploaded-verified" },
      promotion: { state: "pending" },
    });
  });

  it("reconciles an existing version only from exact registry archive bytes", async () => {
    const fake = recordingRun({ archive: Buffer.from(item.bytes) });
    const result = await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    expect(result.channelState).toBe("uploaded");
    expect(fake.calls.some(({ command, args }) => command === "npm" && args[0] === "publish")).toBe(
      false,
    );
    const fakeConflict = recordingRun({ archive: Buffer.from("different archive") });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fakeConflict.run,
        fetchImpl: fakeConflict.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/immutable-version-conflict/u);
  });

  it("reuses an exact existing archive when the npm metadata cache omits its version", async () => {
    const fake = recordingRun({
      archive: Buffer.from(item.bytes),
      metadataAlways404: true,
      directArchiveVisibleOnMetadata404: true,
    });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        log: () => {},
      }),
    ).resolves.toMatchObject({ channelState: "uploaded", published: false });
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
    ).toHaveLength(0);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({
      state: "existing-exact-bytes",
      readbackSource: "direct-archive-after-metadata-404",
    });
  });

  it("uploads once and promotes when the metadata cache stays stale but archive and tags are visible", async () => {
    const fake = recordingRun({
      metadataAlways404: true,
      directArchiveVisibleOnMetadata404: true,
    });
    const logs = [];
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        log: (line) => logs.push(line),
      }),
    ).resolves.toMatchObject({ channelState: "uploaded", published: true });
    const promoted = await publishPackage({
      argv: ["promote", "package-artifacts"],
      env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: (line) => logs.push(line),
    });
    expect(promoted).toMatchObject({ channelState: "verified", observedVersion: VERSION });
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
    ).toHaveLength(1);
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toHaveLength(1);
    expect(
      fake.calls.filter(
        ({ command, args }) =>
          command === "registry" && args[0].endsWith("/-/package/docsfab/dist-tags"),
      ),
    ).toHaveLength(3);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({ readbackSource: "direct-archive-after-metadata-404" });
    expect(receipt.promotion).toMatchObject({ state: "promoted-observed" });
    expect(
      logs.filter((line) => /direct project archive read after metadata E404/u.test(line)),
    ).toHaveLength(2);
  });

  it("reconciles a lost publish response from the direct exact archive while metadata is stale", async () => {
    const fake = recordingRun({
      publishFails: true,
      metadataAlways404: true,
      directArchiveVisibleOnMetadata404: true,
    });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        log: () => {},
      }),
    ).resolves.toMatchObject({ channelState: "uploaded" });
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
    ).toHaveLength(1);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({
      state: "reconciled-after-response-loss",
      readbackSource: "direct-archive-after-metadata-404",
    });
  });

  it("refuses a direct-archive authorization error and conflicting bytes without another publish", async () => {
    for (const [fake, reasonClass] of [
      [
        recordingRun({
          archive: item.bytes,
          metadataAlways404: true,
          directArchiveVisibleOnMetadata404: true,
          directArchiveStatusOnMetadata404: 403,
        }),
        "authorization",
      ],
      [
        recordingRun({
          archive: Buffer.from("different archive"),
          metadataAlways404: true,
          directArchiveVisibleOnMetadata404: true,
        }),
        "different_bytes",
      ],
    ]) {
      await expect(
        publishPackage({
          argv: ["upload", "package-artifacts"],
          env: ENV,
          projectRoot: item.projectRoot,
          run: fake.run,
          fetchImpl: fake.fetchImpl,
          log: () => {},
        }),
      ).rejects.toThrow(/version-bytes-unknown|immutable-version-conflict/u);
      expect(
        fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
      ).toHaveLength(0);
      const receipt = JSON.parse(
        await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
      );
      expect(receipt.upload.reasonClass).toBe(reasonClass);
    }
  });

  it("does not apply the candidate archive fallback to a prior channel winner", async () => {
    const oldVersion = `0.0.9-main.${"a".repeat(8)}`;
    const fake = recordingRun({
      tags: { main: oldVersion },
      archiveByVersion: { [oldVersion]: item.bytes },
      metadataAlways404: true,
      directArchiveVisibleOnMetadata404: true,
    });
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    await expect(
      publishPackage({
        argv: ["promote", "package-artifacts"],
        env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/current main channel archive is unavailable/u);
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toHaveLength(0);
    expect(
      fake.calls.filter(
        ({ command, args }) =>
          command === "registry" && args[0].endsWith(`docsfab-${oldVersion}.tgz`),
      ),
    ).toHaveLength(0);
  });

  it("reconciles a lost upload response only when exact bytes are readable", async () => {
    const recovered = recordingRun({ publishFails: true });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: recovered.run,
        fetchImpl: recovered.fetchImpl,
        log: () => {},
      }),
    ).resolves.toMatchObject({ channelState: "uploaded" });
    expect(
      recovered.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
    ).toHaveLength(1);
    expect(
      recovered.calls.filter(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toHaveLength(0);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload.state).toBe("reconciled-after-response-loss");

    const absent = recordingRun({ publishFailsWithoutStore: true });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: absent.run,
        fetchImpl: absent.fetchImpl,
        wait: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/publication-state-unknown/u);
    const unknownReceipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(unknownReceipt.upload.state).toBe("unknown");
    expect(unknownReceipt.upload.reasonClass).toBe("eventual_visibility");
  });

  it("retries absent exact-version metadata after upload with fresh online reads", async () => {
    const catalog = JSON.parse(
      await readFile(new URL("../../../config/limits.catalog.json", import.meta.url), "utf8"),
    );
    const fake = recordingRun({ delayedUploadReadbacks: 2, requireOnlineReadback: true });
    const waits = [];
    const result = await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      wait: async (ms) => waits.push(ms),
      log: () => {},
    });
    expect(result.channelState).toBe("uploaded");
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
    ).toHaveLength(1);
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toHaveLength(0);
    const publishIndex = fake.calls.findIndex(
      ({ command, args }) => command === "npm" && args[0] === "publish",
    );
    const reads = fake.calls
      .slice(publishIndex + 1)
      .filter(
        ({ command, args }) =>
          command === "npm" && args[0] === "view" && args[2] === "dist.tarball",
      );
    expect(reads).toHaveLength(3);
    expect(
      reads.every(
        ({ args, options }) =>
          args.includes("--prefer-online") &&
          options.timeout === catalog.limits["publishPackage.versionReadbackTimeoutMs"].value,
      ),
    ).toBe(true);
    expect(waits).toEqual(
      Array(2).fill(catalog.limits["publishPackage.versionReadbackDelayMs"].value),
    );
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({ state: "uploaded-verified", readbackAttempts: 3 });
  });

  it("retries an absent exact-version tarball after metadata is visible", async () => {
    const fake = recordingRun({ delayedUploadArchive404: 1 });
    const waits = [];
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        wait: async (ms) => waits.push(ms),
        log: () => {},
      }),
    ).resolves.toMatchObject({ channelState: "uploaded" });
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
    ).toHaveLength(1);
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toHaveLength(0);
    expect(waits).toHaveLength(1);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({ state: "uploaded-verified", readbackAttempts: 2 });
  });

  it("succeeds on the final upload readback attempt after a lost publish response", async () => {
    const catalog = JSON.parse(
      await readFile(new URL("../../../config/limits.catalog.json", import.meta.url), "utf8"),
    );
    const attempts = catalog.limits["publishPackage.versionReadbackAttempts"].value;
    const fake = recordingRun({ publishFails: true, delayedUploadReadbacks: attempts - 1 });
    const waits = [];
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        wait: async (ms) => waits.push(ms),
        log: () => {},
      }),
    ).resolves.toMatchObject({ channelState: "uploaded" });
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
    ).toHaveLength(1);
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toHaveLength(0);
    expect(waits).toHaveLength(attempts - 1);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({
      state: "reconciled-after-response-loss",
      readbackAttempts: attempts,
    });
  });

  it("leaves exhausted upload visibility unknown without another publish or promotion", async () => {
    const fake = recordingRun({ publishFailsWithoutStore: true });
    const waits = [];
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        wait: async (ms) => waits.push(ms),
        log: () => {},
      }),
    ).rejects.toThrow(
      /publication-state-unknown.*bounded.*publishPackage.versionReadbackAttempts/u,
    );
    const catalog = JSON.parse(
      await readFile(new URL("../../../config/limits.catalog.json", import.meta.url), "utf8"),
    );
    const attempts = catalog.limits["publishPackage.versionReadbackAttempts"].value;
    const publishIndex = fake.calls.findIndex(
      ({ command, args }) => command === "npm" && args[0] === "publish",
    );
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish"),
    ).toHaveLength(1);
    expect(
      fake.calls.filter(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toHaveLength(0);
    expect(
      fake.calls
        .slice(publishIndex + 1)
        .filter(
          ({ command, args }) =>
            command === "npm" && args[0] === "view" && args[2] === "dist.tarball",
        ),
    ).toHaveLength(attempts);
    expect(waits).toHaveLength(attempts - 1);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({
      state: "unknown",
      reasonClass: "eventual_visibility",
      readbackAttempts: attempts,
    });
  });

  it.each(["authorization", "malformed", "timeout", "network", "output_bound"])(
    "stops upload readback immediately on %s",
    async (failure) => {
      const fake = recordingRun({ postUploadReadbackFailure: failure });
      const waits = [];
      await expect(
        publishPackage({
          argv: ["upload", "package-artifacts"],
          env: ENV,
          projectRoot: item.projectRoot,
          run: fake.run,
          fetchImpl: fake.fetchImpl,
          wait: async (ms) => waits.push(ms),
          log: () => {},
        }),
      ).rejects.toThrow(/version-bytes-unknown|publish-package-command-output-bytes-bound/u);
      const publishIndex = fake.calls.findIndex(
        ({ command, args }) => command === "npm" && args[0] === "publish",
      );
      expect(
        fake.calls
          .slice(publishIndex + 1)
          .filter(
            ({ command, args }) =>
              command === "npm" && args[0] === "view" && args[2] === "dist.tarball",
          ),
      ).toHaveLength(1);
      expect(waits).toHaveLength(0);
      const receipt = JSON.parse(
        await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
      );
      expect(receipt.upload).toMatchObject({
        state: "unknown",
        reasonClass: failure,
        readbackAttempts: 1,
      });
    },
  );

  it("stops when a hard failure follows an absent post-upload read", async () => {
    const fake = recordingRun({
      delayedUploadReadbacks: 1,
      postUploadReadbackFailure: "authorization",
    });
    const waits = [];
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        wait: async (ms) => waits.push(ms),
        log: () => {},
      }),
    ).rejects.toThrow(/version-bytes-unknown/u);
    expect(waits).toHaveLength(1);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({
      state: "unknown",
      reasonClass: "authorization",
      readbackAttempts: 2,
    });
  });

  it("refuses a conflicting archive on the first post-upload readback", async () => {
    const fake = recordingRun({ postUploadArchive: Buffer.from("different archive") });
    const waits = [];
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        wait: async (ms) => waits.push(ms),
        log: () => {},
      }),
    ).rejects.toThrow(/immutable-version-conflict/u);
    expect(waits).toHaveLength(0);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({ state: "conflict", readbackAttempts: 1 });
  });

  it("leaves upload successful while a legacy channel writer remains undrained", async () => {
    const fake = recordingRun();
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    await expect(
      publishPackage({
        argv: ["promote", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/promotion-cutover-unconfirmed/u);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload.state).toBe("uploaded-verified");
    expect(receipt.promotion.state).toBe("blocked-cutover");
    expect(fake.getTags().main).toBeUndefined();
  });

  it("promotes only after the explicit drain gate and records verified channel state", async () => {
    const fake = recordingRun();
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    const result = await publishPackage({
      argv: ["promote", "package-artifacts"],
      env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    expect(result.channelState).toBe("verified");
    expect(fake.getTags().main).toBe(VERSION);
    expect(
      fake.calls.some(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toBe(true);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload.state).toBe("uploaded-verified");
    expect(receipt.promotion).toMatchObject({
      state: "promoted-observed",
      observedVersion: VERSION,
      readbackAttempts: 1,
    });
  });

  it("keeps post-upload promote --dry-run read-only, then permits ordinary promotion", async () => {
    const fake = recordingRun();
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    const callsBeforeDryRun = fake.calls.length;
    const dryRunResult = await publishPackage({
      argv: ["promote", "package-artifacts", "--dry-run"],
      env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    expect(dryRunResult.channelState).toBe("dry-run");
    expect(dryRunResult.observedVersion).toBeNull();
    expect(
      fake.calls
        .slice(callsBeforeDryRun)
        .filter(
          ({ command, args }) =>
            command === "npm" && (args[0] === "publish" || args[0] === "dist-tag"),
        ),
    ).toHaveLength(0);
    expect(fake.getTags().main).toBeUndefined();
    const dryRunReceipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(dryRunReceipt.upload.state).toBe("uploaded-verified");
    expect(dryRunReceipt.promotion).toMatchObject({ state: "dry-run", observedVersion: null });

    const promoted = await publishPackage({
      argv: ["promote", "package-artifacts"],
      env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    expect(promoted.channelState).toBe("verified");
    expect(fake.getTags().main).toBe(VERSION);
  });

  it("records dry-run when the channel already points at the target and still verifies ordinary promote", async () => {
    const fake = recordingRun({ archive: Buffer.from(item.bytes), tags: { main: VERSION } });
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    const callsBeforeDryRun = fake.calls.length;
    const dryRunResult = await publishPackage({
      argv: ["promote", "package-artifacts", "--dry-run"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    expect(dryRunResult).toMatchObject({ channelState: "dry-run", observedVersion: VERSION });
    const dryRunReceipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(dryRunReceipt.promotion).toMatchObject({
      state: "dry-run",
      observedVersion: VERSION,
    });
    expect(fake.getTags().main).toBe(VERSION);
    expect(
      fake.calls
        .slice(callsBeforeDryRun)
        .filter(
          ({ command, args }) =>
            command === "npm" && (args[0] === "publish" || args[0] === "dist-tag"),
        ),
    ).toHaveLength(0);

    const ordinaryResult = await publishPackage({
      argv: ["promote", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    expect(ordinaryResult).toMatchObject({ channelState: "verified", observedVersion: VERSION });
    const ordinaryReceipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(ordinaryReceipt.promotion).toMatchObject({
      state: "promoted-observed",
      observedVersion: VERSION,
    });
    expect(fake.getTags().main).toBe(VERSION);
    expect(
      fake.calls.some(({ command, args }) => command === "npm" && args[0] === "dist-tag"),
    ).toBe(false);
  });

  it("records delayed channel visibility after bounded retries", async () => {
    const oldVersion = `0.1.0-main.${SOURCE_SHA.slice(0, 10)}`;
    const fake = recordingRun({
      delayedPromotionReadbacks: 2,
      tags: { main: oldVersion },
      archiveByVersion: { [oldVersion]: item.bytes },
    });
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    await publishPackage({
      argv: ["promote", "package-artifacts"],
      env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      wait: async () => {},
      log: () => {},
    });
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.promotion).toMatchObject({
      state: "promoted-observed",
      observedVersion: VERSION,
      readbackAttempts: 3,
    });
  });

  it("retries an owned channel readback timeout and persists the observed promotion", async () => {
    const fake = recordingRun();
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    let readbackAttempts = 0;
    const fetchImpl = (url, options) => {
      if (
        String(url).endsWith("/-/package/docsfab/dist-tags") &&
        fake.calls.some(
          ({ command: callCommand, args: callArgs }) =>
            callCommand === "npm" && callArgs[0] === "dist-tag",
        )
      ) {
        readbackAttempts += 1;
        if (readbackAttempts === 1) {
          const error = new Error("owned readback deadline expired");
          error.reasonClass = "timeout";
          throw error;
        }
      }
      return fake.fetchImpl(url, options);
    };
    const result = await publishPackage({
      argv: ["promote", "package-artifacts"],
      env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl,
      wait: async () => {},
      log: () => {},
    });
    expect(result.channelState).toBe("verified");
    expect(readbackAttempts).toBe(2);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.promotion).toMatchObject({
      state: "promoted-observed",
      observedVersion: VERSION,
      readbackAttempts: 2,
    });
  });

  it("persists unknown timeout after the governed readback attempts are exhausted", async () => {
    const fake = recordingRun({ promotionReadbackFailure: "timeout" });
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    await expect(
      publishPackage({
        argv: ["promote", "package-artifacts"],
        env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        wait: async () => {},
        log: () => {},
      }),
    ).rejects.toMatchObject({
      reasonClass: "timeout",
      message: expect.stringMatching(/channel-readback-unknown/u),
    });
    const addIndex = fake.calls.findIndex(
      ({ command, args }) => command === "npm" && args[0] === "dist-tag",
    );
    const readsAfterWrite = fake.calls
      .slice(addIndex + 1)
      .filter(
        ({ command, args }) =>
          command === "registry" && args[0].endsWith("/-/package/docsfab/dist-tags"),
      );
    const catalog = JSON.parse(
      await readFile(new URL("../../../config/limits.catalog.json", import.meta.url), "utf8"),
    );
    expect(readsAfterWrite).toHaveLength(
      catalog.limits["publishPackage.channelReadbackAttempts"].value,
    );
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.promotion).toMatchObject({ state: "unknown", reasonClass: "timeout" });
  });

  it("keeps exhausted visibility unknown and fails malformed or unauthorized readback immediately", async () => {
    const oldVersion = `0.1.0-main.${SOURCE_SHA.slice(0, 10)}`;
    const exhausted = recordingRun({
      delayedPromotionReadbacks: 50,
      tags: { main: oldVersion },
      archiveByVersion: { [oldVersion]: item.bytes },
    });
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: exhausted.run,
      fetchImpl: exhausted.fetchImpl,
      log: () => {},
    });
    await expect(
      publishPackage({
        argv: ["promote", "package-artifacts"],
        env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
        projectRoot: item.projectRoot,
        run: exhausted.run,
        fetchImpl: exhausted.fetchImpl,
        wait: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/bounded readback window/u);
    const exhaustedReceipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(exhaustedReceipt.promotion).toMatchObject({
      state: "unknown",
      reasonClass: "eventual_visibility",
    });

    for (const failure of ["malformed", "authorization"]) {
      const fake = recordingRun({
        promotionReadbackFailure: failure,
        tags: { main: oldVersion },
        archiveByVersion: { [oldVersion]: item.bytes },
      });
      await publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        log: () => {},
      });
      await expect(
        publishPackage({
          argv: ["promote", "package-artifacts"],
          env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
          projectRoot: item.projectRoot,
          run: fake.run,
          fetchImpl: fake.fetchImpl,
          wait: async () => {},
          log: () => {},
        }),
      ).rejects.toThrow(
        failure === "malformed" ? /channel-readback-unknown/u : /channel-readback-unknown/u,
      );
      const addIndex = fake.calls.findIndex(
        ({ command, args }) => command === "npm" && args[0] === "dist-tag",
      );
      const readsAfterWrite = fake.calls
        .slice(addIndex + 1)
        .filter(
          ({ command, args }) =>
            command === "registry" && args[0].endsWith("/-/package/docsfab/dist-tags"),
        );
      expect(readsAfterWrite).toHaveLength(1);
    }
  });

  it("promotes over an authenticated older-base main winner when its source is an ancestor", async () => {
    const oldRevision = "a".repeat(40);
    const oldVersion = `0.0.9-main.${oldRevision.slice(0, 8)}`;
    const oldContainer = join(root, "old-container");
    const oldRoot = join(oldContainer, "package");
    await mkdir(join(oldRoot, "dist"), { recursive: true });
    await writeFile(
      join(oldRoot, "dist", "build-identity.js"),
      `export const DOCSFAB_BUILD_IDENTITY = Object.freeze(${JSON.stringify({ schemaVersion: 1, commit: oldRevision, dirty: false })});\n`,
    );
    const oldPath = join(root, "old.tgz");
    await execute("tar", ["-czf", oldPath, "-C", oldContainer, "package"]);
    const oldBytes = await readFile(oldPath);
    const fake = recordingRun({
      archiveByVersion: { [oldVersion]: oldBytes },
      tags: { main: oldVersion },
      requireAuthConfig: true,
      ancestorPairs: new Set([`${oldRevision}:${SOURCE_SHA}`]),
    });
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    const result = await publishPackage({
      argv: ["promote", "package-artifacts"],
      env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    expect(result.channelState).toBe("verified");
    expect(fake.getTags().main).toBe(VERSION);
    const winnerRead = fake.calls.find(
      ({ command, args }) =>
        command === "npm" && args[0] === "view" && args[1] === `docsfab@${oldVersion}`,
    );
    expect(winnerRead.options.env.npm_config_userconfig).toMatch(/\.npmrc$/u);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.promotion).toMatchObject({
      state: "promoted-observed",
      observedVersion: VERSION,
    });
  });

  it("retains a malformed channel readback as unknown and non-success", async () => {
    const fake = recordingRun({ malformedTags: true });
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    await expect(
      publishPackage({
        argv: ["promote", "package-artifacts"],
        env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/channel-readback-unknown/u);
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload.state).toBe("uploaded-verified");
    expect(receipt.promotion).toMatchObject({ state: "unknown", reasonClass: "malformed" });
  });

  it("detects an outside writer that changes the channel during ancestry admission", async () => {
    const fake = recordingRun({ outsideWriterOnFetch: true });
    await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    });
    await expect(
      publishPackage({
        argv: ["promote", "package-artifacts"],
        env: { ...ENV, DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED: "true" },
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/channel-concurrent-update/u);
    expect(fake.getTags().main).toBe("0.1.0-main.bbbbbbbb");
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.promotion).toMatchObject({ state: "unknown", reasonClass: "concurrent_writer" });
  });

  it("keeps dry-run read-only and reports archive readback uncertainty as non-success", async () => {
    const dry = recordingRun();
    const result = await publishPackage({
      argv: ["upload", "package-artifacts", "--dry-run"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: dry.run,
      fetchImpl: dry.fetchImpl,
      log: () => {},
    });
    expect(result.channelState).toBe("dry-run");
    expect(
      dry.calls.some(
        ({ command, args }) => command === "npm" && ["publish", "dist-tag"].includes(args[0]),
      ),
    ).toBe(false);
    const unknown = recordingRun({ failPack: true });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: unknown.run,
        fetchImpl: unknown.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/version-bytes-unknown/u);
    expect(
      JSON.parse(await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8")).upload
        .reasonClass,
    ).toBe("authorization");
    const malformed = recordingRun({ malformedPack: true });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: malformed.run,
        fetchImpl: malformed.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/version-bytes-unknown/u);
    expect(
      JSON.parse(await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8")).upload
        .reasonClass,
    ).toBe("malformed");
    const timeoutError = new Error("registry request timed out");
    timeoutError.code = "ETIMEDOUT";
    const timeout = recordingRun({ packError: timeoutError });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: timeout.run,
        fetchImpl: timeout.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/version-bytes-unknown/u);
    expect(
      JSON.parse(await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8")).upload
        .reasonClass,
    ).toBe("timeout");
    const networkError = new Error("network connection reset");
    networkError.code = "ECONNRESET";
    const network = recordingRun({ packError: networkError });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: network.run,
        fetchImpl: network.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/version-bytes-unknown/u);
    expect(
      JSON.parse(await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8")).upload
        .reasonClass,
    ).toBe("network");
    const oversized = recordingRun({ oversizedPack: true, archive: Buffer.from(item.bytes) });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: oversized.run,
        fetchImpl: oversized.fetchImpl,
        log: () => {},
      }),
    ).rejects.toMatchObject({
      reasonClass: "size_bound",
      diagnosticCode: "publish-package-registry-archive-bound",
      message: expect.stringContaining(
        "observed 67108865 bytes, maximum 67108864 bytes; scope=registry archive",
      ),
    });
    expect(
      JSON.parse(await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8")).upload
        .reasonClass,
    ).toBe("size_bound");
    const overflow = recordingRun({ overflow: "view" });
    let output = "";
    try {
      await publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: overflow.run,
        fetchImpl: overflow.fetchImpl,
        log: () => {},
      });
    } catch (error) {
      output = error.message;
    }
    expect(output).toMatch(/version-bytes-unknown/u);
    expect(output).not.toContain("private marker");
    expect(
      JSON.parse(await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8")).upload
        .reasonClass,
    ).toBe("output_bound");
  });

  it("does not trust forged archive-bound diagnostics from a failed registry body", async () => {
    const forgedError = Object.assign(new Error("private archive marker"), {
      diagnosticCode: "publish-package-registry-archive-bound",
      refusal: "publish-package-registry-archive-bound",
    });
    const fake = recordingRun({ archiveBodyError: forgedError });
    const failure = await publishPackage({
      argv: ["upload", "package-artifacts"],
      env: ENV,
      projectRoot: item.projectRoot,
      run: fake.run,
      fetchImpl: fake.fetchImpl,
      log: () => {},
    }).then(
      () => null,
      (error) => error,
    );

    expect(failure).toMatchObject({ reasonClass: "download" });
    expect(failure.message).toMatch(/version-bytes-unknown: registry archive download failed/u);
    expect(failure.message).not.toContain("private archive marker");
    expect(failure).not.toHaveProperty("diagnosticCode");
    expect(failure.message).not.toContain("publish-package-registry-archive-bound");
    const receipt = JSON.parse(
      await readFile(join(item.artifactRoot, "publication-receipt.json"), "utf8"),
    );
    expect(receipt.upload).toMatchObject({ state: "unknown", reasonClass: "download" });
  });

  it("requires an explicit upload or promote phase at both argument boundaries", async () => {
    expect(() => parseArguments(["package-artifacts"])).toThrow(/usage/u);
    expect(() => parseArguments(["upload", "package-artifacts"])).not.toThrow();
    await expect(
      publishPackage({
        argv: ["package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: async () => {
          throw new Error("must not run");
        },
        log: () => {},
      }),
    ).rejects.toThrow(/usage/u);
  });

  it("rejects malformed command arguments and output overflow without echoing private output", async () => {
    expect(() => parseArguments(["../outside"])).toThrow(/usage/u);
    expect(() => parseArguments(["package-artifacts", "--force"])).toThrow(/usage/u);
    const fake = recordingRun({ overflow: "view" });
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: ENV,
        projectRoot: item.projectRoot,
        run: fake.run,
        fetchImpl: fake.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/version-bytes-unknown/u);
    const { CI_JOB_TOKEN: _token, ...withoutToken } = ENV;
    const noCalls = recordingRun();
    await expect(
      publishPackage({
        argv: ["upload", "package-artifacts"],
        env: withoutToken,
        projectRoot: item.projectRoot,
        run: noCalls.run,
        fetchImpl: noCalls.fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/CI_JOB_TOKEN is required/u);
    expect(noCalls.calls).toEqual([]);
  });

  it("cancels 404 and 403 error bodies before returning or refusing", async () => {
    for (const status of [404, 403]) {
      let canceled = false;
      let signal;
      const body = new ReadableStream(
        {
          cancel() {
            canceled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const fetchImpl = async (_url, options) => {
        signal = options.signal;
        return new Response(body, { status });
      };
      const path = join(root, `error-${status}.tgz`);
      if (status === 404) {
        await expect(
          downloadBoundedArchive({
            url: `${REGISTRY}docsfab/-/docsfab-1.0.0.tgz`,
            registry: REGISTRY,
            token: "test-token",
            destination: path,
            fetchImpl,
          }),
        ).resolves.toBeNull();
      } else {
        await expect(
          downloadBoundedArchive({
            url: `${REGISTRY}docsfab/-/docsfab-1.0.0.tgz`,
            registry: REGISTRY,
            token: "test-token",
            destination: path,
            fetchImpl,
          }),
        ).rejects.toMatchObject({ reasonClass: "authorization" });
      }
      expect(canceled).toBe(true);
      expect(signal.aborted).toBe(true);
      await expect(access(path)).rejects.toThrow();
    }
  });

  it("scopes bearer auth to the registry path across same-host and cross-host redirects", async () => {
    const outside = "https://registry.example.invalid/api/v4/projects/2/packages/npm/docsfab.tgz";
    const storage = "https://storage.example.invalid/signed.tar.gz";
    for (const redirects of [[outside], [storage, outside]]) {
      const calls = [];
      const replies = [
        ...redirects.map((location) => new Response(null, { status: 302, headers: { location } })),
        new Response(new Uint8Array()),
      ];
      const path = join(root, `redirect-${redirects.length}.tgz`);
      await downloadBoundedArchive({
        url: `${REGISTRY}docsfab/-/docsfab-1.0.0.tgz`,
        registry: REGISTRY,
        token: "test-token",
        destination: path,
        fetchImpl: async (url, options) => {
          calls.push({ url: String(url), authorization: options.headers.authorization });
          return replies.shift();
        },
      });
      expect(calls[0].authorization).toBe("Bearer test-token");
      expect(calls.at(-1).authorization).toBeUndefined();
    }
  });

  it("refuses redirect chains beyond the governed bound", async () => {
    let canceled = false;
    const body = new ReadableStream(
      {
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      downloadBoundedArchive({
        url: `${REGISTRY}docsfab/-/docsfab-1.0.0.tgz`,
        registry: REGISTRY,
        token: "test-token",
        destination: join(root, "redirect-overflow.tgz"),
        maxRedirects: 0,
        fetchImpl: async () =>
          new Response(body, { status: 302, headers: { location: `${REGISTRY}next` } }),
      }),
    ).rejects.toMatchObject({ reasonClass: "malformed" });
    expect(canceled).toBe(true);
  });
});
