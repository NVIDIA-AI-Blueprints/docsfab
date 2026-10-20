// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDnsHostname } from "../../shared/dns-hostname.js";
import { fail } from "./primitives.js";

const SAFE_PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface ParsedRemote {
  host: string;
  projectPath: string;
  transport: "ssh" | "https";
}

export function parseGitLabRemote(value: string): ParsedRemote {
  if (/[\0\r\n]/u.test(value)) fail("unsupported-remote");
  if (value.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail("unsupported-remote");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      !safeHost(url.hostname) ||
      knownNonGitLabHost(url.hostname)
    ) {
      fail("unsupported-remote");
    }
    return {
      host: url.hostname.toLowerCase(),
      projectPath: parseProjectPath(url.pathname),
      transport: "https",
    };
  }
  const scp = /^git@([^/:]+):(.+)$/u.exec(value);
  const ssh = /^ssh:\/\/git@([^/:]+)(?::([0-9]{1,5}))?\/(.+)$/u.exec(value);
  const host = scp?.[1] ?? ssh?.[1];
  const projectPath = scp?.[2] ?? ssh?.[3];
  const port = ssh?.[2];
  if (
    !host ||
    !projectPath ||
    !safeHost(host) ||
    knownNonGitLabHost(host) ||
    (port !== undefined && (Number(port) < 1 || Number(port) > 65_535))
  ) {
    fail("unsupported-remote");
  }
  return {
    host: host.toLowerCase(),
    projectPath: parseProjectPath(`/${projectPath}`),
    transport: "ssh",
  };
}

function parseProjectPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname)
      .replace(/^\/+|\/+$/gu, "")
      .replace(/\.git$/u, "");
  } catch {
    fail("unsupported-remote");
  }
  const segments = decoded.split("/");
  if (segments.length < 2 || segments.some((segment) => !SAFE_PROJECT_SEGMENT.test(segment))) {
    fail("unsupported-remote");
  }
  return segments.join("/");
}

export function safeBranch(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    value === value.normalize("NFC") &&
    !/[\0-\x20\x7f~^:?*[\\]/u.test(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value
      .split("/")
      .some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"))
  );
}

function safeHost(value: string): boolean {
  return isDnsHostname(value, { anyCase: true });
}

function knownNonGitLabHost(value: string): boolean {
  return /^(?:www\.)?(?:github\.com|bitbucket\.org|dev\.azure\.com)$/iu.test(value);
}

export function safeProjectPath(value: string): boolean {
  const segments = value.split("/");
  return segments.length >= 2 && segments.every((segment) => SAFE_PROJECT_SEGMENT.test(segment));
}

export function safeProtectionPattern(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    value === value.normalize("NFC") &&
    !/[\0\r\n\\]/u.test(value) &&
    value.split("/").every(Boolean)
  );
}

export function branchRuleMatches(pattern: string, branch: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
  return new RegExp(`^${escaped}$`, "u").test(branch);
}
