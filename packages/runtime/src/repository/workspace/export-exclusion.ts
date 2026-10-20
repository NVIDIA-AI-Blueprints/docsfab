// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SAFE_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

/** What `isExportExcluded` refuses, for operator copy; keep it beside the rule. */
export const EXPORT_EXCLUSION_DESCRIPTION =
  "credential files (.env and .env.* other than .env.example, .env.sample, and .env.template; " +
  ".npmrc; .pypirc; credentials.json; *.pem; *.key; id_rsa*; id_ed25519*) and files under .aws, " +
  ".ssh, .config/gcloud, node_modules, dist, build, coverage, .next, .cache, target, or __pycache__";

/** Credential-bearing or generated paths that the export must not materialize. */
export function isExportExcluded(path: string): boolean {
  const parts = path.split("/");
  const basename = parts.at(-1)!;
  if ([".env", ".npmrc", ".pypirc", "credentials.json"].includes(basename)) return true;
  if (basename.startsWith(".env.") && !SAFE_ENV_TEMPLATES.has(basename)) return true;
  if (/\.(?:pem|key)$/u.test(basename) || /^(?:id_rsa|id_ed25519)/u.test(basename)) return true;
  if (
    parts.some((part) =>
      [
        ".aws",
        ".ssh",
        "node_modules",
        "dist",
        "build",
        "coverage",
        ".next",
        ".cache",
        "target",
        "__pycache__",
      ].includes(part),
    )
  )
    return true;
  return parts.some((part, index) => part === ".config" && parts[index + 1] === "gcloud");
}
