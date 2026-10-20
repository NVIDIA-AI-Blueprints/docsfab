// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MINIMUM_NODE_VERSION } from "../src/launcher.js";
import { internalOnly } from "./helpers/internal-path.js";

// The runtime manifest's engines.node is the one source of truth for the
// DocsFab Node floor. Every other copy (launcher, sibling manifests, lock
// roots, CI and deploy images, setup scripts, and reader-facing prose) must
// agree with it. The floor moves only at a release boundary, and that move
// is one edit per row this test reports.
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(runtimeRoot, "../..");

// Several rows scan the same pages; read each file once per run.
const texts = new Map<string, string>();
function read(path: string): string {
  let text = texts.get(path);
  if (text === undefined) {
    text = readFileSync(join(repoRoot, path), "utf8");
    texts.set(path, text);
  }
  return text;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

function enginesNode(manifest: Record<string, unknown>): unknown {
  const engines = manifest.engines as Record<string, unknown> | undefined;
  return engines?.node;
}

function lockRootEnginesNode(path: string): unknown {
  const packages = readJson(path).packages as Record<string, Record<string, unknown>> | undefined;
  return packages?.[""] ? enginesNode(packages[""]) : undefined;
}

function floorFromRuntimeManifest(): string {
  const range = enginesNode(readJson("packages/runtime/package.json"));
  const match = typeof range === "string" ? /^>=(\d+\.\d+\.\d+)$/u.exec(range) : null;
  if (!match) {
    throw new Error(
      `packages/runtime/package.json engines.node must be a single ">=X.Y.Z" floor; found ${JSON.stringify(range)}`,
    );
  }
  return match[1]!;
}

const FLOOR = floorFromRuntimeManifest();

// Any official node tag that starts with a version: a distro or variant
// suffix (bookworm, trixie, alpine, and so on) and a bare version both count.
const IMAGE_PATTERN = /\bnode:(\d+(?:\.\d+)*)(?:-[a-z0-9][a-z0-9.-]*)?(@sha256:[0-9a-f]{64})?/gu;

// Phrases that state a Node minimum: "Node.js X or later" (or newer), "Node
// X+", "node is older than X", "reports X or later", "Node.js >=X", "the Node
// X runtime floor", and "CI exercises it on Node X".
const PROSE_PATTERNS = [
  /\bNode(?:\.js)?\s+(\d+(?:\.\d+){0,2})(?:\+|\s+or\s+(?:later|newer))/gu,
  /\bnode(?:\.js)?(?:\s+--version)?`?\s+is\s+older\s+than\s+(\d+\.\d+(?:\.\d+)?)/giu,
  /\breports?\s+(\d+\.\d+(?:\.\d+)?)\s+or\s+(?:later|newer)/gu,
  /\bNode(?:\.js)?\s+>=(\d+\.\d+\.\d+)/gu,
  /\bNode\s+(\d+\.\d+\.\d+)\s+runtime\s+floor/gu,
  /\bexercises\s+it\s+on\s+Node\s+(\d+\.\d+\.\d+)/gu,
] as const;

interface ImageReference {
  readonly version: string;
  readonly digest: string | undefined;
}

function imageReferences(path: string): ImageReference[] {
  return [...read(path).matchAll(IMAGE_PATTERN)].map((match) => ({
    version: match[1]!,
    digest: match[2],
  }));
}

function proseVersions(path: string): string[] {
  const text = read(path);
  return PROSE_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!));
}

function filesUnder(directory: string, keep: (path: string) => boolean): string[] {
  return readdirSync(join(repoRoot, directory), { recursive: true, encoding: "utf8" })
    .map((entry) => relative(repoRoot, join(repoRoot, directory, entry)))
    .filter((path) => !path.split("/").includes("node_modules") && keep(path))
    .sort();
}

const isMarkdown = (path: string) => path.endsWith(".md");
// Maintainer notes and retained evidence under the runtime docs are not
// reader-facing and are not exported; they may quote historical floors.
const isPublishedMarkdown = (path: string) =>
  isMarkdown(path) &&
  !path.startsWith("packages/runtime/docs/internal/") &&
  !path.startsWith("packages/runtime/docs/evidence/");

/** Image drift rows for `paths`; `required` paths must name at least one image. */
function imageDrift(paths: readonly string[], required: readonly string[]): string[] {
  const drift: string[] = [];
  for (const path of paths) {
    const references = imageReferences(path);
    if (references.length === 0 && required.includes(path)) {
      drift.push(`${path}: no node image reference found`);
    }
    for (const { version } of references) {
      if (version !== FLOOR) drift.push(`${path}: node:${version} (expected node:${FLOOR})`);
    }
  }
  return drift;
}

/** Prose drift rows for `paths`; `required` paths must state a minimum at least once. */
function proseDrift(paths: readonly string[], required: readonly string[]): string[] {
  const drift: string[] = [];
  for (const path of paths) {
    const versions = proseVersions(path);
    if (versions.length === 0 && required.includes(path)) {
      drift.push(`${path}: no Node minimum statement found`);
    }
    for (const version of versions) {
      if (version !== FLOOR) drift.push(`${path}: states Node ${version} (expected ${FLOOR})`);
    }
  }
  return drift;
}

/** The one digest shared by every digest-pinned runtime image reference in `paths`. */
function digestDrift(paths: readonly string[]): { missing: string[]; digests: Set<string> } {
  const missing: string[] = [];
  const digests = new Set<string>();
  for (const path of paths) {
    for (const { version, digest } of imageReferences(path)) {
      if (!digest) missing.push(`${path}: node:${version} has no @sha256 digest`);
      else digests.add(digest);
    }
  }
  return { missing, digests };
}

// Exported runtime images; the digest-pinned one must keep its digest.
const RUNTIME_IMAGE_FILES = ["packages/runtime/ci/Dockerfile.ci", "packages/runtime/ci/Dockerfile"];
const RUNTIME_DIGEST_FILES = ["packages/runtime/ci/Dockerfile"];

// Exported reader-facing pages that state the Node minimum.
const PROSE_FILES = [
  "README.md",
  "packages/runtime/README.md",
  "packages/knowledge/README.md",
  "packages/runtime/docs/get-started/installation-reference.md",
  "packages/runtime/deployment/brev/README.md",
  "packages/runtime/deployment/workstation/README.md",
  "packages/runtime/test/support/discovery/README.md",
  "docs/get-started/installation.md",
  "docs/reference/support-matrix.md",
  "docs/troubleshooting.md",
  "docs/workflows/run-a-documentation-workflow.md",
];

describe("Node floor drift", () => {
  it("reads one exact floor from the runtime manifest", () => {
    expect(FLOOR).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("keeps the launcher, the knowledge manifest, and the runtime lock roots on the floor", () => {
    expect({
      "packages/runtime/src/launcher.ts MINIMUM_NODE_VERSION": MINIMUM_NODE_VERSION,
      "packages/knowledge/package.json engines.node": enginesNode(
        readJson("packages/knowledge/package.json"),
      ),
      "packages/runtime/npm-shrinkwrap.json root engines.node": lockRootEnginesNode(
        "packages/runtime/npm-shrinkwrap.json",
      ),
      "packages/runtime/package-lock.json root engines.node": lockRootEnginesNode(
        "packages/runtime/package-lock.json",
      ),
    }).toEqual({
      "packages/runtime/src/launcher.ts MINIMUM_NODE_VERSION": FLOOR,
      "packages/knowledge/package.json engines.node": `>=${FLOOR}`,
      "packages/runtime/npm-shrinkwrap.json root engines.node": `>=${FLOOR}`,
      "packages/runtime/package-lock.json root engines.node": `>=${FLOOR}`,
    });
  });

  it("pins the runtime CI images to the floor release and keeps the digest pin", () => {
    expect(imageDrift(RUNTIME_IMAGE_FILES, RUNTIME_IMAGE_FILES)).toEqual([]);
    const { missing, digests } = digestDrift(RUNTIME_DIGEST_FILES);
    expect(missing).toEqual([]);
    expect(digests.size).toBe(1);
  });

  it("keeps the runtime bootstrap script on the floor release", () => {
    const bootstrapFloor = /^NODE_MIN_VERSION=(\S+)$/mu.exec(
      read("packages/runtime/deployment/brev/bootstrap.sh"),
    )?.[1];
    expect(bootstrapFloor).toBe(FLOOR);
  });

  it("states the floor release wherever exported prose names a Node minimum", () => {
    const scanned = [
      ...new Set([
        ...PROSE_FILES,
        ...filesUnder("docs", isMarkdown),
        ...filesUnder("packages/runtime/docs", isPublishedMarkdown),
      ]),
    ];
    expect(proseDrift(scanned, PROSE_FILES)).toEqual([]);
    // The floor moves only at a release boundary, not when a line becomes
    // Active LTS; prose that ties it to Active LTS misleads readers.
    expect(scanned.filter((path) => /\bActive LTS\b/u.test(read(path)))).toEqual([]);
  });
});

// The CI definition, the deploy tree, and the host package also carry copies
// of the floor. The public export leaves them out, so these rows skip only in
// an exported tree; in this repository a missing path fails instead.
const INTERNAL_SOURCES = internalOnly(
  [
    ".gitlab-ci.yml",
    ".gitlab/ci",
    "deploy",
    "packages/host/package.json",
    "packages/host/package-lock.json",
  ],
  "the CI definition, deploy tree, and host package are not exported",
);

// Qualified with its own receipt and re-qualification path: it runs a
// candidate's checks with networking off, not the DocsFab runtime.
const SEALED_VALIDATION_IMAGE = "deploy/compose/docker-desktop-validation.yaml";

const DEPLOY_TEXT = /(?:\.(?:md|sh|ya?ml|ipynb|mjs|json)|\/Dockerfile[^/]*)$/u;

describe.skipIf(INTERNAL_SOURCES.skip)(
  INTERNAL_SOURCES.title("Node floor drift, internal sources"),
  () => {
    it("keeps the host manifest and its lock root on the floor", () => {
      expect({
        "packages/host/package.json engines.node": enginesNode(
          readJson("packages/host/package.json"),
        ),
        "packages/host/package-lock.json root engines.node": lockRootEnginesNode(
          "packages/host/package-lock.json",
        ),
      }).toEqual({
        "packages/host/package.json engines.node": `>=${FLOOR}`,
        "packages/host/package-lock.json root engines.node": `>=${FLOOR}`,
      });
    });

    it("pins every GitLab CI Node image to the floor release", () => {
      const ciFiles = [
        ".gitlab-ci.yml",
        ...filesUnder(".gitlab/ci", (path) => /\.ya?ml$/u.test(path)),
      ];
      expect(imageDrift(ciFiles, [".gitlab-ci.yml"])).toEqual([]);
      expect(ciFiles.flatMap(imageReferences).length).toBeGreaterThan(1);
    });

    it("pins every deploy Node image to the floor release and keeps the compose digest", () => {
      const deployFiles = filesUnder(
        "deploy",
        (path) => DEPLOY_TEXT.test(path) && path !== SEALED_VALIDATION_IMAGE,
      );
      const composeFiles = ["deploy/compose/Dockerfile", "deploy/compose/README.md"];
      expect(imageDrift(deployFiles, composeFiles)).toEqual([]);
      const { missing, digests } = digestDrift([...composeFiles, ...RUNTIME_DIGEST_FILES]);
      expect(missing).toEqual([]);
      // The compose and runtime CI images name the same bookworm-slim release.
      expect(digests.size).toBe(1);
    });

    it("keeps the deploy setup scripts on the floor", () => {
      const fallbacks = filesUnder("deploy", (path) => path.endsWith(".sh")).flatMap((path) =>
        [...read(path).matchAll(/^FALLBACK_REQUIRED_NODE="([^"]+)"$/gmu)].map(
          (match) => `${basename(path)}=${match[1]}`,
        ),
      );
      expect(fallbacks.length).toBeGreaterThan(0);
      expect(fallbacks.filter((entry) => !entry.endsWith(`=${FLOOR}`))).toEqual([]);

      const launchable = read("deploy/brev/launchable-setup.sh");
      const major = /^NODE_MAJOR=(\d+)$/mu.exec(launchable)?.[1];
      const minor = /^NODE_MINOR_MIN=(\d+)$/mu.exec(launchable)?.[1];
      // launchable-setup.sh compares major and minor only, which equals the
      // floor exactly while the floor's patch is zero. A non-zero patch floor
      // needs that script to compare the patch too.
      expect(`${major}.${minor}.0`).toBe(FLOOR);
    });

    it("states the floor release wherever deploy prose names a Node minimum", () => {
      const required = ["deploy/brev/README.md", "deploy/notebook/demo.ipynb"];
      const deployProse = filesUnder(
        "deploy",
        (path) => isMarkdown(path) || path.endsWith(".ipynb"),
      );
      expect(proseDrift(deployProse, required)).toEqual([]);
    });
  },
);
