// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const CHILD_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CI",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "PI_CODING_AGENT_DIR",
  "PI_OFFLINE",
] as const;

const PROXY_NAMES = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]);

/** Environment for an untrusted executable; only known noncredential settings cross the boundary. */
export function untrustedChildEnvironment(
  source: NodeJS.ProcessEnv,
  additions: { readonly CI?: string } = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value === undefined) continue;
    if (PROXY_NAMES.has(name) && proxyContainsCredentials(value)) continue;
    environment[name] = value;
  }
  if (process.platform === "win32" && source.SYSTEMROOT !== undefined) {
    environment.SYSTEMROOT = source.SYSTEMROOT;
  }
  return { ...environment, ...additions };
}

function proxyContainsCredentials(value: string): boolean {
  try {
    const url = value.startsWith("//")
      ? `http:${value}`
      : value.includes("://")
        ? value
        : `http://${value}`;
    const proxy = new URL(url);
    return proxy.username !== "" || proxy.password !== "";
  } catch {
    // An unparseable proxy cannot be proven credential-free at this boundary.
    return true;
  }
}
