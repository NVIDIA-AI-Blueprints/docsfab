// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Native M/B/H and upload-pack fixture for the installed CLI path. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limit } from "../../src/config/limits.js";

function gitEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALLOW_PROTOCOL: "file",
    LANG: "C",
    LC_ALL: "C",
  };
}

function git(root: string, cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(root),
  }).trim();
}

export async function githubPrReviewFixture(
  codeOnly = false,
  colliding = false,
  emptyHead = false,
  excludedSpecial = false,
  extraHeadDocs = 0,
  layout: "markdown" | "forked-mdx" | "mixed-code" = "markdown",
) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-github-basis-"));
  const work = join(root, "work");
  const scratch = join(root, "scratch");
  await mkdir(work);
  await mkdir(scratch);
  git(root, work, "init", "-q");
  git(root, work, "config", "user.name", "Fixture");
  git(root, work, "config", "user.email", "fixture@example.invalid");
  if (colliding) git(root, work, "config", "core.precomposeunicode", "false");
  await mkdir(join(work, "docs"));
  if (excludedSpecial) {
    await mkdir(join(work, ".aws"));
    await writeFile(join(work, ".aws", "private.md"), "# Must never leave private Git\n");
    await symlink("../docs/unchanged.md", join(work, ".aws", "link.md"));
    await symlink("unchanged.md", join(work, "docs", "link.md"));
  }
  await writeFile(join(work, "docs", "unchanged.md"), "# Unchanged at H\n");
  await writeFile(join(work, "docs", "before.md"), "# Merge base\n");
  await writeFile(
    join(work, "docs", "package.json"),
    JSON.stringify({
      name: "fixture-docs",
      version: "1.0.0",
      scripts: { "lint:docs": "echo checked" },
    }),
  );
  await writeFile(
    join(work, "AGENTS.md"),
    "# Checks\nRun `npm run lint:docs` in `docs` to validate documentation.\n",
  );
  await writeFile(join(work, "docs", "deleted.md"), "# M-before deleted document\n");
  git(root, work, "add", ".");
  git(root, work, "commit", "-qm", "common");
  const M = git(root, work, "rev-parse", "HEAD");
  git(root, work, "branch", "proposal");
  await writeFile(join(work, "docs", "before.md"), "# Target base B\n");
  await writeFile(join(work, "docs", "target-only.md"), "# Base-only context\n");
  git(root, work, "add", ".");
  if (excludedSpecial)
    git(root, work, "update-index", "--add", "--cacheinfo", `160000,${M},.ssh/vendor.md`);
  git(root, work, "commit", "-qm", "target diverges");
  const B = git(root, work, "rev-parse", "HEAD");
  const baseTree = git(root, work, "rev-parse", "HEAD^{tree}");
  git(root, work, "switch", "-q", "proposal");
  if (emptyHead) git(root, work, "rm", "-rq", ".");
  else if (codeOnly) await writeFile(join(work, "code.ts"), "export const answer = 1;\n");
  else {
    git(root, work, "rm", "-q", "docs/deleted.md");
    await writeFile(
      join(work, "docs", layout === "forked-mdx" ? "after.mdx" : "after.md"),
      "# Proposal after\n",
    );
    if (layout === "mixed-code")
      await writeFile(join(work, "code.ts"), "export const answer = 1;\n");
    if (colliding) await writeFile(join(work, "docs", "é.md"), "# Unicode at H\n");
    for (let index = 0; index < extraHeadDocs; index += 1)
      await writeFile(join(work, "docs", `extra-${index}.md`), `# Extra H ${index}\n`);
  }
  git(root, work, "add", ".");
  if (colliding) {
    const blob = git(root, work, "hash-object", "-w", "docs/é.md");
    git(root, work, "update-index", "--add", "--cacheinfo", `100644,${blob},docs/é.md`);
  }
  if (excludedSpecial && !emptyHead)
    git(root, work, "update-index", "--add", "--cacheinfo", `160000,${M},modules/example`);
  if (excludedSpecial)
    git(root, work, "update-index", "--add", "--cacheinfo", `160000,${M},.ssh/vendor.md`);
  git(root, work, "commit", "-qm", "proposal");
  const H = git(root, work, "rev-parse", "HEAD");
  const headTree = git(root, work, "rev-parse", "HEAD^{tree}");
  const unchangedBlob = emptyHead ? "" : git(root, work, "rev-parse", "HEAD:docs/unchanged.md");
  const target = join(root, "target.git");
  const fork = join(root, "fork.git");
  execFileSync("git", ["clone", "-q", "--bare", work, target], { env: gitEnv(root) });
  execFileSync("git", ["clone", "-q", "--bare", work, fork], { env: gitEnv(root) });
  // The caller checkout is deliberately no longer H; the provider may only use the pinned public objects.
  if (!colliding && !emptyHead) {
    await writeFile(join(work, "docs", "unchanged.md"), "# Mutable caller checkout, not H\n");
    git(root, work, "add", ".");
    git(root, work, "commit", "-qm", "caller checkout drifts after public clone");
  }
  const repositories = (id: number, owner: string) => ({
    id,
    full_name: `${owner}/docs`,
    private: false,
    visibility: "public",
  });
  let apiRequests = 0;
  const apiFetch = async (url: string, init: RequestInit) => {
    apiRequests += 1;
    if (init.method !== "GET") throw new Error("Fixture API expected GET.");
    const path = new URL(url).pathname;
    const body =
      path === "/repos/target/docs" || path === "/repositories/10"
        ? repositories(10, "target")
        : path === "/repositories/11"
          ? repositories(11, "fork")
          : path === "/repositories/10/git/ref/heads/main"
            ? { object: { type: "commit", sha: B } }
            : path === "/repos/target/docs/pulls/884"
              ? {
                  number: 884,
                  state: "open",
                  merged: false,
                  base: { ref: "main", sha: M, repo: repositories(10, "target") },
                  head: { sha: H, repo: repositories(11, "fork") },
                }
              : (() => {
                  throw new Error(`unexpected API path ${path}`);
                })();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const requests: Buffer[] = [];
  const responseLengths: number[] = [];
  const responseByRequest = new Map<string, Buffer>();
  const objectFetch = async (url: string, init: RequestInit) => {
    const repository = url.includes("/fork/") ? fork : target;
    const discovery = init.method === "GET";
    const request = discovery ? undefined : Buffer.from(init.body as Buffer);
    if (request) requests.push(request);
    const key = `${url}/${init.method}/${request?.toString("hex") ?? ""}`;
    let bytes = responseByRequest.get(key);
    if (!bytes) {
      const result = spawnSync(
        "git",
        [
          "-c",
          "uploadpack.allowFilter=true",
          "-c",
          "uploadpack.allowAnySHA1InWant=true",
          "upload-pack",
          "--stateless-rpc",
          ...(discovery ? ["--http-backend-info-refs"] : []),
          repository,
        ],
        {
          input: request,
          maxBuffer: limit("changeSourcesGithub.acquisitionMaxBytes").value,
          env: {
            PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
            HOME: root,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_PROTOCOL: "version=2",
            LANG: "C",
            LC_ALL: "C",
          },
        },
      );
      if (result.status !== 0) throw new Error(`native upload-pack exited ${result.status}`);
      bytes = result.stdout;
      responseByRequest.set(key, bytes);
    }
    responseLengths.push(bytes.length);
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": discovery
          ? "application/x-git-upload-pack-advertisement"
          : "application/x-git-upload-pack-result",
      },
    });
  };
  return {
    root,
    work,
    scratch,
    B,
    H,
    M,
    baseTree,
    headTree,
    unchangedBlob,
    requests,
    responseLengths,
    apiRequestCount: () => apiRequests,
    apiFetch,
    objectFetch,
  };
}
