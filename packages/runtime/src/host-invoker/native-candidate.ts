// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Separate exact-revision candidate for nested native authoring. */
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fetchTrustedLocalGitRevision, runTrustedGit } from "./trusted-git.js";

export interface HostedNativeCandidate {
  readonly workspacePath: string;
  readonly revision: string;
  readonly treeObjectId: string;
  dispose(): Promise<void>;
}

export async function createHostedNativeCandidate(input: {
  sourcePath: string;
  stateDirectory: string;
  revision: string;
  treeObjectId: string;
  signal?: AbortSignal;
}): Promise<HostedNativeCandidate> {
  const state = await lstat(input.stateDirectory);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== process.getuid?.() ||
    (state.mode & 0o777) !== 0o700 ||
    (await realpath(input.stateDirectory)) !== input.stateDirectory
  )
    throw new Error("Native authoring requires the current private attempt directory.");
  const sourceRevision = (
    await runTrustedGit(
      input.sourcePath,
      ["rev-parse", "--verify", `${input.revision}^{commit}`],
      input.signal,
    )
  )
    .toString()
    .trim();
  const sourceTree = (
    await runTrustedGit(
      input.sourcePath,
      ["rev-parse", "--verify", `${input.revision}^{tree}`],
      input.signal,
    )
  )
    .toString()
    .trim();
  if (sourceRevision !== input.revision || sourceTree !== input.treeObjectId)
    throw new Error("Native authoring source differs from the exact outer request.");
  const objectFormat = (
    await runTrustedGit(input.sourcePath, ["rev-parse", "--show-object-format"], input.signal)
  )
    .toString()
    .trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    throw new Error("Native authoring source has an unsupported Git object format.");
  const workspacePath = await mkdtemp(join(input.stateDirectory, "authoring-"));
  await chmod(workspacePath, 0o700);
  try {
    await runTrustedGit(
      workspacePath,
      ["init", "--quiet", `--object-format=${objectFormat}`],
      input.signal,
    );
    await fetchTrustedLocalGitRevision(
      workspacePath,
      input.sourcePath,
      input.revision,
      input.signal,
    );
    await runTrustedGit(
      workspacePath,
      ["checkout", "--quiet", "--detach", input.revision, "--"],
      input.signal,
    );
    const revision = (await runTrustedGit(workspacePath, ["rev-parse", "HEAD"], input.signal))
      .toString()
      .trim();
    const treeObjectId = (
      await runTrustedGit(workspacePath, ["rev-parse", "HEAD^{tree}"], input.signal)
    )
      .toString()
      .trim();
    // Fail-closed postcondition on the external Git process, not a decision on
    // caller input: the source check above already refuses caller-reachable
    // divergence. A dirty tree here means a checkout filter or attribute
    // rewrote content.
    if (
      revision !== input.revision ||
      treeObjectId !== input.treeObjectId ||
      (
        await runTrustedGit(
          workspacePath,
          ["status", "--porcelain=v1", "--untracked-files=all"],
          input.signal,
        )
      ).length !== 0
    )
      throw new Error("Native authoring candidate does not match the selected source revision.");
    let disposed = false;
    return Object.freeze({
      workspacePath,
      revision,
      treeObjectId,
      async dispose() {
        if (!disposed) {
          disposed = true;
          await rm(workspacePath, { recursive: true, force: true });
        }
      },
    });
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}
