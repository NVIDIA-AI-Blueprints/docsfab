// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  claimRepositoryWorkspaceLease,
  releaseRepositoryWorkspaceLease,
  verifyActiveRepositoryWorkspace,
} from "./tracked-read.js";

/** Serializes mutations of a harness-owned disposable export. */
export async function acquireRepositoryWorkspaceLease(workspace: unknown): Promise<() => void> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  claimRepositoryWorkspaceLease(verified);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseRepositoryWorkspaceLease(verified);
  };
}
