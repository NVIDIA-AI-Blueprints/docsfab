// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Project config validation and private-root resolution for DocsFab init.
 */
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";

import type { DocsFabPrivateRoots, DocsFabProjectConfigV1 } from "./types.js";
import {
  assertCredentialFree,
  credentialFree,
  exactKeys,
  normalizedAbsolute,
  object,
  safeBranch,
  safeRemoteName,
} from "./shared.js";

export function resolveDocsFabPrivateRoots(
  repositoryPath: string,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): DocsFabPrivateRoots {
  const canonicalHome = normalizedAbsolute(homeDirectory, "home directory");
  const configuredState = environment.XDG_STATE_HOME;
  const base =
    configuredState === undefined || configuredState === ""
      ? resolve(canonicalHome, ".local", "state", "docsfab")
      : resolve(normalizedAbsolute(configuredState, "XDG_STATE_HOME"), "docsfab");
  const projectId = createHash("sha256")
    .update(normalizedAbsolute(repositoryPath, "repository path"))
    .digest("hex");
  const projectRoot = resolve(base, "projects", projectId);
  return {
    runs: resolve(projectRoot, "runs"),
    evidence: resolve(projectRoot, "evidence"),
    delivery: resolve(projectRoot, "delivery"),
    receipts: resolve(projectRoot, "receipts"),
  };
}

const PROJECT_CONFIG_REQUIRED_KEYS = ["gitlab", "provider", "schemaVersion", "storage"] as const;
const PROJECT_CONFIG_OPTIONAL_KEYS = ["documentationRoots"] as const;

export function assertDocsFabProjectConfig(
  value: unknown,
): asserts value is DocsFabProjectConfigV1 {
  if (object(value) && hasUnreadProjectConfigKey(value)) {
    // The key itself is never echoed: an arbitrary key may carry credential material.
    throw new Error(
      "Existing DocsFab project configuration has a top-level key DocsFab does not read; keep only schemaVersion, gitlab, provider, storage, and documentationRoots in .docsfab.json, then retry. No project file was changed.",
    );
  }
  if (
    !object(value) ||
    !projectConfigExactKeys(value) ||
    value.schemaVersion !== 1 ||
    !object(value.gitlab) ||
    !exactKeys(value.gitlab, ["defaultBranch", "remote"]) ||
    typeof value.gitlab.remote !== "string" ||
    !safeRemoteName(value.gitlab.remote) ||
    typeof value.gitlab.defaultBranch !== "string" ||
    !safeBranch(value.gitlab.defaultBranch) ||
    !object(value.provider) ||
    !exactKeys(value.provider, ["configuration"]) ||
    value.provider.configuration !== "host" ||
    !object(value.storage) ||
    !exactKeys(value.storage, ["scope"]) ||
    value.storage.scope !== "user-private" ||
    (value.documentationRoots !== undefined && !isDocumentationRoots(value.documentationRoots))
  ) {
    throw new Error(
      "Existing DocsFab project configuration is invalid; no project file was changed.",
    );
  }
  assertCredentialFree(
    value,
    "Existing DocsFab project configuration contains forbidden credential material.",
  );
}

function hasUnreadProjectConfigKey(value: Record<string, unknown>): boolean {
  const known: readonly string[] = [
    ...PROJECT_CONFIG_REQUIRED_KEYS,
    ...PROJECT_CONFIG_OPTIONAL_KEYS,
  ];
  return Object.keys(value).some((key) => !known.includes(key));
}

function projectConfigExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    PROJECT_CONFIG_REQUIRED_KEYS.every((key) => keys.includes(key)) &&
    !hasUnreadProjectConfigKey(value) &&
    new Set(keys).size === keys.length
  );
}

function isDocumentationRoots(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false;
  if (!value.every((item) => typeof item === "string" && isDocumentationRoot(item))) return false;
  return new Set(value).size === value.length;
}

function isDocumentationRoot(value: string): boolean {
  if (
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    value === "." ||
    value === "" ||
    value.startsWith("./") ||
    value.length > 200
  ) {
    return false;
  }
  if (posix.normalize(value) !== value) return false;
  if (value.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return credentialFree(value);
}
