// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  prepareRepositoryCheckCapability,
  repositoryCheckPolicyDigest,
  type RepositoryCheckCapability,
  type RepositoryCheckPolicy,
} from "../templates/checks.js";

const DOCUMENT_TEXT_CHECK = [
  "const fs=require('node:fs'),p=require('node:path'),d=new TextDecoder('utf-8',{fatal:true});",
  "const skip=new Set(['.git','node_modules','.docsfab']);",
  "function walk(x){for(const n of fs.readdirSync(x,{withFileTypes:true})){if(skip.has(n.name))continue;const f=p.join(x,n.name);",
  "if(n.isSymbolicLink())throw new Error('documentation tree contains a symlink');",
  "if(n.isDirectory())walk(f);else if(/\\.(?:md|mdx)$/u.test(n.name)){const b=fs.readFileSync(f);",
  "if(b.length>16777216)throw new Error('documentation file exceeds 16 MiB');d.decode(b);}}}",
  "walk(process.cwd());",
].join("");

/** Stable host-owned validation policy used by local site-bootstrap commands. */
export function standardSiteBootstrapCheckPolicy(
  executable = process.execPath,
): RepositoryCheckPolicy {
  const value = {
    id: "docsfab:site-bootstrap-document-text",
    version: "1",
    checks: [
      {
        id: "documentation-text",
        executable,
        args: ["-e", DOCUMENT_TEXT_CHECK],
        timeoutMs: 60_000,
      },
    ],
  };
  return { ...value, digest: repositoryCheckPolicyDigest(value) };
}

/** Seal the standard local policy into the opaque repository-check capability. */
export async function prepareStandardSiteBootstrapChecks(
  executable = process.execPath,
): Promise<RepositoryCheckCapability> {
  return prepareRepositoryCheckCapability({
    policy: standardSiteBootstrapCheckPolicy(executable),
    allowedExecutables: [executable],
  });
}
