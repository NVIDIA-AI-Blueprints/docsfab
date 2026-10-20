// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side Slack → local `docsfab` argv planner (non-product dogfood).
 *
 * Chat text never grants `--allow-write` or publish. Only allowlisted
 * workflow names and repository roots are accepted.
 */

import { lstat, realpath, readFile } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";

export const FORBIDDEN_TOKENS = Object.freeze([
  "--allow-write",
  "--apply",
  "--execute",
  "--publish",
  "--instruction",
  "publish",
  "auto",
  "do",
  "profile",
  "roadmap-issues",
  "roadmap-plan",
  "ia",
  "init",
  "doctor",
  "multi-unit-campaign",
]);

const FORBIDDEN_PREFIXES = Object.freeze([
  "--confirm-",
  "--private-key",
  "--authorization",
  "--authority",
]);

const WORKFLOW_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const SHELL_META = /[;|&`$()<>\n\r]/;
const ALLOWED_FLAGS = new Set(["--repo", "--revision", "--json"]);

/**
 * @param {string} filePath
 * @returns {Promise<{ workflows: string[], repoRoots: string[] }>}
 */
export async function loadAllowlist(filePath) {
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Allowlist must be a JSON object.");
  }
  const workflows = raw.workflows;
  const repoRoots = raw.repoRoots;
  if (!Array.isArray(workflows) || workflows.length === 0) {
    throw new Error("Allowlist.workflows must be a non-empty string array.");
  }
  if (!Array.isArray(repoRoots) || repoRoots.length === 0) {
    throw new Error("Allowlist.repoRoots must be a non-empty string array.");
  }
  for (const name of workflows) {
    if (typeof name !== "string" || !WORKFLOW_NAME.test(name)) {
      throw new Error(`Invalid allowlisted workflow name: ${String(name)}`);
    }
  }
  for (const root of repoRoots) {
    if (typeof root !== "string" || !isAbsolute(root)) {
      throw new Error("Each allowlisted repo root must be an absolute path.");
    }
  }
  return {
    workflows: [...new Set(workflows)],
    repoRoots: [...repoRoots],
  };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeSlashText(text) {
  if (typeof text !== "string") {
    throw refuse("invalid-syntax", "Slash text must be a string.");
  }
  if (SHELL_META.test(text)) {
    throw refuse("invalid-syntax", "Slash text must not contain shell metacharacters.");
  }
  if ((text.match(/"/g) || []).length % 2 !== 0) {
    throw refuse("invalid-syntax", "Slash text has unmatched quotes.");
  }
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match = re.exec(text);
  while (match) {
    tokens.push(match[1] !== undefined ? match[1] : match[2]);
    match = re.exec(text);
  }
  return tokens;
}

/**
 * Plan a local `docsfab run` argv from Slack slash text.
 *
 * @param {{ text: string, allowlist: { workflows: string[], repoRoots: string[] } }} input
 * @returns {Promise<
 *   | { ok: true, argv: string[], workflow: string, repo: string }
 *   | { ok: false, code: string, message: string }
 * >}
 */
export async function planInvoke(input) {
  try {
    return await planInvokeOrThrow(input);
  } catch (error) {
    if (error && typeof error === "object" && error.bridgeRefuse) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

async function planInvokeOrThrow({ text, allowlist }) {
  const tokens = tokenizeSlashText(text.trim());
  if (tokens.length === 0) {
    throw refuse("invalid-syntax", "Expected: run <workflow> --repo <absolute-path>");
  }

  let rest = tokens;
  const first = rest[0]?.toLowerCase() ?? "";
  if (first === "/docsfab" || first === "docsfab") {
    rest = rest.slice(1);
  }
  if (rest[0]?.toLowerCase() === "run") {
    rest = rest.slice(1);
  }
  if (rest.length === 0) {
    throw refuse("invalid-syntax", "Expected a catalogued workflow name after run.");
  }

  for (const token of rest) {
    const lower = token.toLowerCase();
    if (FORBIDDEN_TOKENS.includes(lower) || FORBIDDEN_TOKENS.includes(token)) {
      throw refuse(
        "forbidden-token",
        "Chat text is not a write grant. This bridge never passes --allow-write or publish from Slack.",
      );
    }
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (lower.startsWith(prefix) || token.startsWith(prefix)) {
        throw refuse(
          "forbidden-token",
          "Chat text is not a write grant. This bridge never passes --allow-write or publish from Slack.",
        );
      }
    }
    if (lower.includes("allow-write") || lower.includes("--publish")) {
      throw refuse(
        "forbidden-token",
        "Chat text is not a write grant. This bridge never passes --allow-write or publish from Slack.",
      );
    }
  }

  const workflow = rest[0];
  if (typeof workflow !== "string" || !WORKFLOW_NAME.test(workflow)) {
    throw refuse("unknown-workflow", `Refusing workflow name ${JSON.stringify(workflow)}.`);
  }
  if (!allowlist.workflows.includes(workflow)) {
    throw refuse(
      "unknown-workflow",
      `Workflow ${JSON.stringify(workflow)} is not on the host allowlist.`,
    );
  }

  const flags = parseBoundedFlags(rest.slice(1));
  const repo = await resolveAllowlistedRepo(flags.repo, allowlist.repoRoots);
  const argv = ["run", workflow, "--repo", repo];
  if (flags.revision !== undefined) {
    argv.push("--revision", flags.revision);
  }
  if (flags.json) {
    argv.push("--json");
  }
  return { ok: true, argv, workflow, repo };
}

function parseBoundedFlags(tokens) {
  /** @type {{ repo?: string, revision?: string, json: boolean }} */
  const flags = { json: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw refuse("invalid-syntax", `Unexpected argument ${JSON.stringify(token)}.`);
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (!ALLOWED_FLAGS.has(name)) {
      throw refuse("invalid-syntax", `Flag ${JSON.stringify(name)} is not allowed from Slack.`);
    }
    if (name === "--json") {
      if (eq !== -1) {
        throw refuse("invalid-syntax", "--json does not take a value.");
      }
      flags.json = true;
      continue;
    }
    const value = eq === -1 ? tokens[index + 1] : token.slice(eq + 1);
    if (eq === -1) {
      index += 1;
    }
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw refuse("invalid-syntax", `${name} requires a value.`);
    }
    if (name === "--repo") {
      flags.repo = value;
    } else if (name === "--revision") {
      if (!/^[A-Za-z0-9._/-]{1,128}$/.test(value)) {
        throw refuse("invalid-syntax", "Revision is not a bounded git ref token.");
      }
      flags.revision = value;
    }
  }
  if (typeof flags.repo !== "string") {
    throw refuse("invalid-syntax", "run requires --repo <absolute-path>.");
  }
  return flags;
}

async function resolveAllowlistedRepo(repoPath, repoRoots) {
  if (!isAbsolute(repoPath) || repoPath.includes("\0")) {
    throw refuse(
      "path-not-allowlisted",
      "Repository path must be absolute and on the host allowlist.",
    );
  }
  const parts = repoPath.split(/[/\\]/);
  if (parts.includes("..")) {
    throw refuse("path-not-allowlisted", "Repository path must not contain .. segments.");
  }
  let resolved;
  try {
    const stats = await lstat(repoPath);
    if (stats.isSymbolicLink() || stats.isDirectory() || stats.isFile()) {
      resolved = await realpath(repoPath);
    } else {
      throw new Error("not a directory");
    }
  } catch {
    throw refuse(
      "path-not-allowlisted",
      "Repository path is not a resolvable directory on this host.",
    );
  }
  const stats = await lstat(resolved);
  if (!stats.isDirectory()) {
    throw refuse("path-not-allowlisted", "Repository path must be a directory.");
  }
  const roots = [];
  for (const root of repoRoots) {
    try {
      roots.push(await realpath(root));
    } catch {
      throw refuse(
        "path-not-allowlisted",
        "An allowlisted repo root is not resolvable on this host.",
      );
    }
  }
  if (!roots.some((root) => isPathInsideRoot(root, resolved))) {
    throw refuse(
      "path-not-allowlisted",
      "Repository path is outside the host allowlist of repo roots.",
    );
  }
  return resolved;
}

export function isPathInsideRoot(root, candidate) {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  error.bridgeRefuse = true;
  return error;
}
