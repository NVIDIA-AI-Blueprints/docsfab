// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Default `--comment-mr` port for the local runtime CLI.
 *
 * Runtime keeps the `CommentExistingMrPort` contract and glab observe helpers.
 * Host-backed `project()` wiring lives in the host factory next to the
 * review-summary callable. This module never loads that projector;
 * composition roots inject a port.
 */

import type { CommentExistingMrPort } from "./comment-existing-mr.js";

export const COMMENT_EXISTING_MR_PORT_REQUIRED =
  "docsfab run --comment-mr requires an injected host review-summary port. " +
  "Runtime does not load the host projector; compose createCommentExistingMrPort " +
  "at the host composition root.";

/**
 * Local `docsfab run --comment-mr` has no default host projector.
 * Inject `options.commentExistingMr` or fail closed.
 */
export async function loadDefaultCommentExistingMrPort(
  _repositoryPath?: string,
): Promise<CommentExistingMrPort> {
  throw new Error(COMMENT_EXISTING_MR_PORT_REQUIRED);
}
