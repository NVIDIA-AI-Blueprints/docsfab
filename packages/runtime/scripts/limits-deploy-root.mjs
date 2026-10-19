// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy scan root of check:limits, read from configuration rather than
 * named in code.
 *
 * A host deployment lives in one directory under `deploy/`. Its name belongs
 * to that host, so `config/limits-deploy.json` declares it and the public
 * export leaves the file out. Without the file there is no deploy root: no
 * deploy literal scan, no deploy allowlist shard, and no deploy shell mirror.
 * This module reads only `node:` built-ins: `check-limits.mjs` also runs
 * before `npm ci`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEPLOY_ROOT_CONFIG_PATH = "config/limits-deploy.json";
export const DEPLOY_SHELL_MIRROR_NAME = "limits.generated.sh";
// The deploy scope's parent directory. The export manifest excludes it whole,
// and the shard file rule turns `deploy/<name>` into `deploy.<name>.json`,
// which the manifest also excludes.
const DEPLOY_PARENT = "deploy";
// Mirrors limits-allowlist-shards.mjs OWNER_SEGMENT_RE: no `.`, so the derived
// shard file name maps back to exactly one owner.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const KEYS = Object.freeze(["scanRoot"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a parsed `config/limits-deploy.json` document and return its
 * repository-relative scan root.
 */
export function parseDeployRootConfig(document) {
  if (!isPlainObject(document)) {
    throw new Error(`${DEPLOY_ROOT_CONFIG_PATH} must be an object declaring ${KEYS.join(", ")}`);
  }
  const unknown = Object.keys(document).filter((key) => !KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${DEPLOY_ROOT_CONFIG_PATH} may declare only ${KEYS.join(", ")}; found ${unknown.join(", ")}`,
    );
  }
  const { scanRoot } = document;
  const [parent, ...name] = typeof scanRoot === "string" ? scanRoot.split("/") : [];
  if (
    parent !== DEPLOY_PARENT ||
    name.length === 0 ||
    !name.every((segment) => SEGMENT_RE.test(segment))
  ) {
    throw new Error(
      `${DEPLOY_ROOT_CONFIG_PATH} scanRoot must be a directory under ${DEPLOY_PARENT}/ named by plain segments (no '.', no empty segment); found ${JSON.stringify(scanRoot)}`,
    );
  }
  return scanRoot;
}

/**
 * The configured deploy scan root under `repoRoot`, or null when
 * `config/limits-deploy.json` is absent, as it is in the public export.
 */
export function loadDeployRoot(repoRoot) {
  const path = join(repoRoot, DEPLOY_ROOT_CONFIG_PATH);
  // Handles exactly: the file is absent. A present file that cannot be read
  // or parsed refuses below.
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  let document;
  // Handles exactly JSON.parse rejecting the text; a read error keeps its own
  // message because the read happens before this try.
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${DEPLOY_ROOT_CONFIG_PATH} is not valid JSON: ${error.message}`);
  }
  return parseDeployRootConfig(document);
}

/** The shell limits mirror a deploy root sources. */
export function deployShellMirrorPath(deployRoot) {
  return `${deployRoot}/${DEPLOY_SHELL_MIRROR_NAME}`;
}
